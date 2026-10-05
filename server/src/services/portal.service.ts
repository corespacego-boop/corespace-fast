import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { ParsersService } from './parsers.service';

@Injectable()
export class PortalService {
  private sessions: Map<string, { cookies: string[]; captchaBytes?: Buffer }> = new Map();

  constructor(private readonly parsersService: ParsersService) {}

  private getClient(cookies: string[] = []): AxiosInstance {
    return axios.create({
      baseURL: 'https://sp.srmist.edu.in',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Cookie': cookies.join('; '),
      },
      timeout: 10000,
    });
  }

  // Fetch Portal Captcha Image
  async loadCaptcha(sessionId?: string) {
    const sid = sessionId || Math.random().toString(36).substring(2, 10);
    try {
      const client = this.getClient();
      // Load login page to get JSESSIONID
      const pageRes = await client.get('/srmiststudentportal/students/loginManager/youLogin.jsp');
      const setCookies = pageRes.headers['set-cookie'] || [];
      const cookies = setCookies.map((c) => c.split(';')[0]);

      // Fetch Captcha Image
      const captchaRes = await client.get('/srmiststudentportal/captcha.jpg', {
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
      };
    } catch (err) {
      throw new HttpException('Student Portal unavailable right now.', HttpStatus.SERVICE_UNAVAILABLE);
    }
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
