import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { ParsersService } from './parsers.service';

@Injectable()
export class AcademiaService {
  constructor(private readonly parsersService: ParsersService) {}

  // Check if netid@srmist.edu.in exists on Academia
  async checkAcademiaUserExists(username: string): Promise<boolean> {
    const cleanUser = username.includes('@') ? username : `${username}@srmist.edu.in`;
    try {
      const payload = new URLSearchParams({
        username: cleanUser,
        password: 'dummy_check_password_12345',
        client_portal: 'true',
        portal: '10002227248',
        servicename: 'ZohoCreator',
        serviceurl: 'https://academia.srmist.edu.in/',
        is_ajax: 'true',
        grant_type: 'password',
        service_language: 'en',
      });

      const res = await axios.post('https://accounts.srmist.edu.in/signin/v2/lookup/login', payload.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: 10000,
      });

      const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      const err = data.error || {};
      if (typeof err === 'object' && 'password' in err) return true;

      const msg = String(err.msg || err).toLowerCase();
      if (msg.includes('invalid email') || msg.includes('user does not exist') || msg.includes('invalid username')) {
        return false;
      }
      if (data.code === 'HIP_REQUIRED' || data.code === 'HIP_FAILED' || data.cdigest || data.data) {
        return true;
      }
      return false;
    } catch (err) {
      return false;
    }
  }

  // Authenticate & Fetch Academia Data
  async fetchAcademiaData(username: string, password: string) {
    const cleanUser = username.includes('@') ? username : `${username}@srmist.edu.in`;
    try {
      const payload = new URLSearchParams({
        username: cleanUser,
        password: password,
        client_portal: 'true',
        portal: '10002227248',
        servicename: 'ZohoCreator',
        serviceurl: 'https://academia.srmist.edu.in/',
        is_ajax: 'true',
        grant_type: 'password',
        service_language: 'en',
      });

      const loginRes = await axios.post('https://accounts.srmist.edu.in/signin/v2/lookup/login', payload.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: 10000,
      });

      const cookies = loginRes.headers['set-cookie'] || [];
      const cookieStr = cookies.map((c) => c.split(';')[0]).join('; ');

      const client = axios.create({
        baseURL: 'https://academia.srmist.edu.in',
        headers: {
          'Cookie': cookieStr,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: 10000,
      });

      const [profRes, ttRes, planRes] = await Promise.allSettled([
        client.get('/srm_university/academia-academic-services/page/My_Time_Table_2023_24'),
        client.get('/srm_university/academia-academic-services/page/Unified_Time_Table_2025_Batch_1'),
        client.get('/srm_university/academia-academic-services/page/Academic_Planner_2025_26_EVEN'),
      ]);

      const profHtml = profRes.status === 'fulfilled' ? profRes.value.data.toString() : '';
      const ttHtml = ttRes.status === 'fulfilled' ? ttRes.value.data.toString() : '';
      const planHtml = planRes.status === 'fulfilled' ? planRes.value.data.toString() : '';

      const profile = this.parsersService.parseAcademiaProfile(profHtml);
      const { schedule, courseMap } = this.parsersService.parsePortalTimetable(ttHtml);
      const { entries: calendar, dayOrder } = this.parsersService.parseCalendar(planHtml);

      return {
        profile,
        courses: courseMap,
        timetable: schedule,
        calendar,
        day_order: dayOrder,
      };
    } catch (err) {
      return null;
    }
  }
}
