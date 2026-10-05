import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';

@Injectable()
export class ParsersService {

  private clean(str: string): string {
    return (str || '').replace(/\s+/g, ' ').trim();
  }

  // Parse Portal Profile
  parsePortalProfile(html: string) {
    if (!html) return {};
    const $ = cheerio.load(html);
    const profile: Record<string, string> = {
      name: '',
      regNo: '',
      program: 'N/A',
      dept: 'N/A',
      semester: 'N/A',
      batch: 'N/A',
      section: 'N/A',
    };

    $('tr').each((_, row) => {
      const tds = $(row).find('td');
      if (tds.length >= 2) {
        const label = this.clean($(tds[0]).text()).toLowerCase();
        const val = this.clean($(tds[1]).text());

        if (label.includes('student name')) profile.name = val;
        else if (label.includes('register no')) profile.regNo = val;
        else if (label.includes('institution') || label.includes('department')) profile.dept = val;
        else if (label.includes('program')) profile.program = val;
        else if (label.includes('batch')) profile.batch = val;
        else if (label.includes('semester')) profile.semester = val;
        else if (label.includes('section')) profile.section = val;
      }
    });

    return profile;
  }

  // Parse Portal Attendance
  parsePortalAttendance(html: string) {
    const courses: any[] = [];
    const monthly: any[] = [];
    if (!html) return { courses, monthly };

    const $ = cheerio.load(html);

    $('table tr').each((_, row) => {
      const cells: string[] = [];
      $(row).find('td, th').each((__, cell) => {
        cells.push(this.clean($(cell).text()));
      });

      if (cells.length === 0) return;
      const firstCell = cells[0];

      // Match Course Code (e.g. 26MEE1001L, 21CSC201J)
      if (/^[A-Z0-9]{6,12}$/i.test(firstCell) && cells.length >= 6) {
        const conducted = parseInt(cells[2]) || 0;
        const present = parseInt(cells[3]) || 0;
        const absent = parseInt(cells[4]) || 0;
        const percent = parseFloat(cells[5].replace('%', '')) || 0;

        courses.push({
          code: firstCell,
          title: cells[1],
          conducted,
          present,
          absent,
          percent,
          isPortal: true,
        });
      }
      // Match Monthly Breakdown (e.g. Aug-2026, Sep-2026)
      else if (/^[A-Za-z]{3}-\d{4}$/.test(firstCell) && cells.length >= 3) {
        monthly.push({
          month: firstCell,
          present: parseInt(cells[1]) || 0,
          absent: parseInt(cells[2]) || 0,
        });
      }
    });

    courses.sort((a, b) => a.percent - b.percent);
    return { courses, monthly };
  }

  // Parse Portal Timetable & Course Map
  parsePortalTimetable(html: string) {
    if (!html) return { schedule: {}, courseMap: {} };

    const $ = cheerio.load(html);
    const courseMap: Record<string, any> = {};

    // 1. Extract Courses Table
    $('table').each((_, table) => {
      const headers = $(table).find('th').map((__, th) => this.clean($(th).text()).toLowerCase()).get();
      const hasCode = headers.some((h) => h.includes('course code'));
      const hasFaculty = headers.some((h) => h.includes('faculty'));

      if (hasCode && hasFaculty) {
        const rows = $(table).find('tr');
        rows.each((__, row) => {
          const cols = $(row).find('td').map((___, td) => this.clean($(td).text())).get();
          if (cols.length >= 5) {
            const cCode = cols[0];
            const cName = cols[1];
            const cCredits = cols[2];
            const cSlot = cols[3];
            const cFaculty = cols[4] || 'TBA';
            const rawRoom = cols[7] || cols[5] || '';

            const isLab = cCode.endsWith('L') || cCode.endsWith('P') || cName.toLowerCase().includes('lab') || cName.toLowerCase().includes('practical');

            if (cCode && !courseMap[cCode]) {
              courseMap[cCode] = {
                code: cCode,
                name: cName,
                title: cName,
                credits: cCredits,
                slot: cSlot,
                faculty: cFaculty,
                room: rawRoom || 'TBA',
                type: isLab ? 'Practical' : 'Theory',
              };
            }
          }
        });
      }
    });

    // 2. Extract Timetable Grid
    const schedule: Record<string, Record<string, any>> = {};
    let timeHeaders: string[] = [];

    // Find grid table containing "Day 1" or time slots
    $('table').each((_, table) => {
      const txt = $(table).text().toLowerCase();
      if (txt.includes('day 1') || txt.includes('08:00') || txt.includes('from')) {
        // Extract time headers
        const headerCells = $(table).find('thead tr th, table tr th').map((__, th) => this.clean($(th).text())).get();
        const extractedTimes: string[] = [];
        headerCells.forEach((cell) => {
          const m = cell.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
          if (m) extractedTimes.push(`${m[1]} - ${m[2]}`);
        });

        if (extractedTimes.length > 0) {
          timeHeaders = extractedTimes;
        }

        // Extract Day Rows
        $(table).find('tr').each((__, row) => {
          const cols = $(row).find('td').map((___, td) => this.clean($(td).text())).get();
          if (cols.length > 1) {
            const dayText = cols[0];
            const dayMatch = dayText.match(/Day\s*(\d+)/i);
            if (dayMatch) {
              const dayName = `Day ${dayMatch[1]}`;
              schedule[dayName] = schedule[dayName] || {};

              cols.slice(1).forEach((cellVal, idx) => {
                if (idx < timeHeaders.length && cellVal && cellVal !== '-' && cellVal !== '--') {
                  const timeSlot = timeHeaders[idx];
                  const code = cellVal;
                  const details = courseMap[code] || {
                    code,
                    name: code,
                    type: 'Theory',
                    room: 'TBA',
                    slot: '',
                  };

                  schedule[dayName][timeSlot] = {
                    time: timeSlot,
                    slot: details.slot || '',
                    code: code,
                    course: details.name,
                    room: details.room || 'TBA',
                    type: details.type || 'Theory',
                  };
                }
              });
            }
          }
        });
      }
    });

    return { schedule, courseMap };
  }

  // Parse Academic Calendar & Day Order
  parseCalendar(html: string) {
    if (!html) return { entries: [], dayOrder: '-' };

    const $ = cheerio.load(html);
    const entries: any[] = [];
    let dayOrder = '-';

    $('tr').each((_, row) => {
      const cols = $(row).find('td').map((__, td) => this.clean($(td).text())).get();
      if (cols.length >= 3) {
        const date = cols[0];
        const day = cols[1];
        const order = cols.length >= 4 ? cols[2] : '-';
        const desc = cols.length >= 4 ? cols[3] : cols[2];

        if (date && day && /^\d+$/.test(date)) {
          entries.push({
            date,
            day,
            dayOrder: order,
            description: desc,
          });
        }
      }
    });

    return { entries, dayOrder };
  }

  // Parse Academia Profile
  parseAcademiaProfile(html: string) {
    if (!html) return {};
    const $ = cheerio.load(html);
    const profile: Record<string, string> = {
      name: '',
      regNo: '',
      program: 'N/A',
      dept: 'N/A',
      semester: 'N/A',
      batch: 'N/A',
      section: 'N/A',
    };

    $('td, div, span, label').each((_, el) => {
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
