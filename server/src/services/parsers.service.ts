import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';

@Injectable()
export class ParsersService {
  
  // Clean text helper
  private clean(str: string): string {
    return (str || '').replace(/\s+/g, ' ').trim();
  }

  // Parse Portal Profile HTML
  parsePortalProfile(html: string) {
    if (!html) return {};
    const $ = cheerio.load(html);
    const profile: Record<string, string> = {};

    $('tr').each((_, row) => {
      const cols = $(row).find('td');
      if (cols.length >= 2) {
        const key = this.clean($(cols[0]).text()).toLowerCase();
        const val = this.clean($(cols[1]).text());
        if (key.includes('name')) profile.name = val;
        else if (key.includes('reg')) profile.regNo = val;
        else if (key.includes('program') || key.includes('degree')) profile.program = val;
        else if (key.includes('department') || key.includes('school')) profile.dept = val;
        else if (key.includes('semester')) profile.semester = val;
        else if (key.includes('batch') || key.includes('year')) profile.batch = val;
        else if (key.includes('section')) profile.section = val;
      }
    });

    return profile;
  }

  // Parse Portal Attendance HTML
  parsePortalAttendance(html: string) {
    if (!html) return { courses: [], monthly: [] };
    const $ = cheerio.load(html);
    const courses: any[] = [];
    const monthly: any[] = [];

    // Summary Table
    $('table').first().find('tr').slice(1).each((_, row) => {
      const cols = $(row).find('td');
      if (cols.length >= 6) {
        courses.push({
          code: this.clean($(cols[0]).text()),
          title: this.clean($(cols[1]).text()),
          conducted: parseInt(this.clean($(cols[2]).text())) || 0,
          present: parseInt(this.clean($(cols[3]).text())) || 0,
          absent: parseInt(this.clean($(cols[4]).text())) || 0,
          percent: parseFloat(this.clean($(cols[5]).text()).replace('%', '')) || 0,
        });
      }
    });

    // Monthly Table
    $('table').eq(1).find('tr').slice(1).each((_, row) => {
      const cols = $(row).find('td');
      if (cols.length >= 3) {
        monthly.push({
          month: this.clean($(cols[0]).text()),
          present: parseInt(this.clean($(cols[1]).text())) || 0,
          absent: parseInt(this.clean($(cols[2]).text())) || 0,
        });
      }
    });

    return { courses, monthly };
  }

  // Parse Portal Timetable HTML
  parsePortalTimetable(html: string) {
    if (!html) return { schedule: {}, courseMap: {} };
    const $ = cheerio.load(html);
    const schedule: Record<string, Record<string, any>> = {};
    const courseMap: Record<string, any> = {};

    let currentDay = '';
    $('tr').each((_, row) => {
      const text = this.clean($(row).text());
      if (text.toLowerCase().includes('day')) {
        currentDay = text.split('-')[0].trim();
        if (!schedule[currentDay]) schedule[currentDay] = {};
      } else {
        const cols = $(row).find('td');
        if (cols.length >= 4 && currentDay) {
          const timeStr = this.clean($(cols[0]).text());
          const slot = this.clean($(cols[1]).text());
          const code = this.clean($(cols[2]).text());
          const course = this.clean($(cols[3]).text());
          const room = cols.length >= 5 ? this.clean($(cols[4]).text()) : '';

          schedule[currentDay][timeStr] = { slot, code, course, room };
          if (code && !courseMap[code]) {
            courseMap[code] = { code, name: course, slot, room, type: 'Theory' };
          }
        }
      }
    });

    return { schedule, courseMap };
  }

  // Parse Calendar HTML
  parseCalendar(html: string) {
    if (!html) return { entries: [], dayOrder: '-' };
    const $ = cheerio.load(html);
    const entries: any[] = [];
    let dayOrder = '-';

    $('tr').each((_, row) => {
      const cols = $(row).find('td');
      if (cols.length >= 3) {
        const date = this.clean($(cols[0]).text());
        const day = this.clean($(cols[1]).text());
        const order = cols.length >= 4 ? this.clean($(cols[2]).text()) : '-';
        const desc = cols.length >= 4 ? this.clean($(cols[3]).text()) : this.clean($(cols[2]).text());

        if (date && day) {
          entries.push({ date, day, dayOrder: order, description: desc });
        }
      }
    });

    return { entries, dayOrder };
  }

  // Parse Academia Profile HTML
  parseAcademiaProfile(html: string) {
    if (!html) return {};
    const $ = cheerio.load(html);
    const profile: Record<string, string> = {};

    $('td, div, span').each((_, el) => {
      const text = this.clean($(el).text());
      if (text.includes('Name :') || text.includes('Name:')) {
        profile.name = text.split(':')[1]?.trim() || '';
      } else if (text.includes('Register No :') || text.includes('Reg No:')) {
        profile.regNo = text.split(':')[1]?.trim() || '';
      } else if (text.includes('Department :') || text.includes('Dept:')) {
        profile.dept = text.split(':')[1]?.trim() || '';
      } else if (text.includes('Program :') || text.includes('Degree:')) {
        profile.program = text.split(':')[1]?.trim() || '';
      } else if (text.includes('Batch :') || text.includes('Batch:')) {
        profile.batch = text.split(':')[1]?.trim() || '';
      } else if (text.includes('Section :') || text.includes('Section:')) {
        profile.section = text.split(':')[1]?.trim() || '';
      }
    });

    return profile;
  }
}
