import { Injectable, HttpException, HttpStatus, OnModuleInit } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import { ParsersService } from './parsers.service';

interface PrefetchedCaptcha {
  session: string;
  cdigest: string;
  image: string;
  captcha_image: string;
  cookies: string[];
  createdAt: number;
}

@Injectable()
export class PortalService implements OnModuleInit {
  private sessions: Map<string, { cookies: string[] }> = new Map();
  private captchaBuffer: PrefetchedCaptcha[] = [];
  private isRefilling = false;
  private readonly BUFFER_SIZE = 4;

  constructor(private readonly parsersService: ParsersService) {}

  onModuleInit() {
    // Pre-fetch captchas in background as soon as module starts
    this.refillCaptchaBuffer();
  }

  private getClient(cookies: string[] = []): AxiosInstance {
    return axios.create({
      baseURL: 'https://sp.srmist.edu.in',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Cookie': cookies.join('; '),
      },
      timeout: 8000,
    });
  }

  // Background Refill Task to keep buffer full
  private async refillCaptchaBuffer() {
    if (this.isRefilling) return;
    this.isRefilling = true;

    try {
      while (this.captchaBuffer.length < this.BUFFER_SIZE) {
        const item = await this.fetchRawCaptcha();
        if (item) {
          this.captchaBuffer.push(item);
        } else {
          break;
        }
      }
    } catch (e) {
      // Background refill warning
    } finally {
      this.isRefilling = false;
    }
  }

  // Internal Raw Fetching
  private async fetchRawCaptcha(): Promise<PrefetchedCaptcha | null> {
    const sid = Math.random().toString(36).substring(2, 10);
    try {
      const client = this.getClient();
      const pageRes = await client.get('/srmiststudentportal/students/loginManager/youLogin.jsp');
      const setCookies = pageRes.headers['set-cookie'] || [];
      const cookies = setCookies.map((c) => c.split(';')[0]);

      const html = pageRes.data.toString();
      const $ = cheerio.load(html);
      let captchaUrl = $('#secure_captcha').attr('data-src') || $('#captchaImg').attr('src') || $('img[alt="Captcha"]').attr('data-src') || $('img[alt="Captcha"]').attr('src');

      if (!captchaUrl) {
        captchaUrl = '/srmiststudentportal/SCaptchaServlet';
      }

      const captchaRes = await client.get(captchaUrl, {
        responseType: 'arraybuffer',
        headers: { Cookie: cookies.join('; ') },
      });

      const base64Img = `data:image/jpeg;base64,${Buffer.from(captchaRes.data).toString('base64')}`;
      this.sessions.set(sid, { cookies });

      return {
        session: sid,
        cdigest: sid,
        image: base64Img,
        captcha_image: base64Img,
        cookies,
        createdAt: Date.now(),
      };
    } catch (err) {
      console.error('[CAPTCHA FETCH ERROR]:', err?.message || err);
      return null;
    }
  }

  // INSTANT Captcha Delivery (pumps from memory buffer)
  async loadCaptcha(sessionId?: string) {
    // Evict old captchas (> 10 mins)
    const now = Date.now();
    this.captchaBuffer = this.captchaBuffer.filter((c) => now - c.createdAt < 600000);

    let captchaItem: PrefetchedCaptcha | undefined = this.captchaBuffer.shift();

    if (!captchaItem) {
      // Fallback: load directly if buffer was empty
      captchaItem = await this.fetchRawCaptcha();
    }

    // Trigger background refill asynchronously (non-blocking)
    setImmediate(() => this.refillCaptchaBuffer());

    if (!captchaItem) {
      throw new HttpException('Student Portal captcha unavailable right now.', HttpStatus.SERVICE_UNAVAILABLE);
    }

    this.sessions.set(captchaItem.session, { cookies: captchaItem.cookies });

    return {
      session: captchaItem.session,
      cdigest: captchaItem.cdigest,
      image: captchaItem.image,
      captcha_image: captchaItem.captcha_image,
    };
  }

  // Authenticate Portal User
  async login(netid: string, password: string, captcha: string, cdigest: string) {
    let sess = this.sessions.get(cdigest);
    if (!sess) {
      const fresh = await this.loadCaptcha();
      sess = this.sessions.get(fresh.session);
      cdigest = fresh.session;
    }

    const cleanNetId = (netid || '').trim().split('@')[0];
    const client = this.getClient(sess.cookies);

    const formData = new URLSearchParams();
    formData.append('txtname', cleanNetId);
    formData.append('txtpwd', password);
    formData.append('txtcaptcha', captcha);
    formData.append('login', 'Login');

    try {
      const res = await client.post('/srmiststudentportal/students/loginManager/youLogin.jsp', formData.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      const bodyText = res.data.toString().toLowerCase();
      if (bodyText.includes('invalid captcha') || bodyText.includes('wrong captcha')) {
        const fresh = await this.loadCaptcha();
        return { ok: false, reason: 'wrong_captcha', fresh };
      }
      if (bodyText.includes('invalid password') || bodyText.includes('invalid credentials')) {
        const fresh = await this.loadCaptcha();
        return { ok: false, reason: 'invalid_credentials', fresh };
      }

      const updatedCookies = [...sess.cookies];
      if (res.headers['set-cookie']) {
        res.headers['set-cookie'].forEach((c) => updatedCookies.push(c.split(';')[0]));
      }

      return { ok: true, cookies: updatedCookies, netid: cleanNetId };
    } catch (err) {
      throw new HttpException('Portal authentication failed.', HttpStatus.UNAUTHORIZED);
    }
  }

  // Fetch Full Portal Data
  async fetchPortalData(cookies: string[]) {
    const client = this.getClient(cookies);

    try {
      const [profRes, attRes, ttRes, calRes] = await Promise.allSettled([
        client.get('/srmiststudentportal/students/report/studentDetails.jsp'),
        client.get('/srmiststudentportal/students/report/attendanceReport.jsp'),
        client.get('/srmiststudentportal/students/report/timetableReport.jsp'),
        client.post('/srmiststudentportal/students/report/AcademicCalenderDetails.jsp', 'academicCalenderMonth=0', {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      ]);

      const profHtml = profRes.status === 'fulfilled' ? profRes.value.data.toString() : '';
      const attHtml = attRes.status === 'fulfilled' ? attRes.value.data.toString() : '';
      const ttHtml = ttRes.status === 'fulfilled' ? ttRes.value.data.toString() : '';
      const calHtml = calRes.status === 'fulfilled' ? calRes.value.data.toString() : '';

      const profile = this.parsersService.parsePortalProfile(profHtml);
      const { courses, monthly } = this.parsersService.parsePortalAttendance(attHtml);
      const { schedule, courseMap } = this.parsersService.parsePortalTimetable(ttHtml);
      const { entries: calendar, dayOrder } = this.parsersService.parseCalendar(calHtml);

      return {
        profile,
        courses: courseMap,
        attendance: courses,
        monthly,
        marks: [],
        timetable: schedule,
        calendar,
        day_order: dayOrder,
      };
    } catch (err) {
      return {
        profile: {},
        courses: {},
        attendance: [],
        monthly: [],
        marks: [],
        timetable: {},
        calendar: [],
        day_order: '-',
      };
    }
  }
}
