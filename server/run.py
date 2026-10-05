#!/usr/bin/env python3
import os
import sys
import asyncio
import getpass
import json
import httpx
from pathlib import Path

# Ensure server directory is in sys.path
server_path = str(Path(__file__).resolve().parent)
if server_path not in sys.path:
    sys.path.insert(0, server_path)

from core.config import LOGIN_URL, HEADERS
from core.academia_client import AcademiaClient
from core.portal_client import PortalSession, PortalClient
from services.profile_service import ProfileService
from services.course_service import CourseService
from services.timetable_service import TimetableService
from services.calendar_service import CalendarService
from services.attendance_service import AttendanceService
from services.marks_service import MarksService

from services.portal_profile_service import PortalProfileService
from services.portal_attendance_service import PortalAttendanceService
from services.portal_marks_service import PortalMarksService
from services.portal_timetable_service import PortalTimetableService


def print_header(title):
    print("\n" + "=" * 65)
    print(f" {title.center(63)} ")
    print("=" * 65)


def format_table(headers, rows):
    if not rows:
        return "No data found."
    col_widths = [len(h) for h in headers]
    for row in rows:
        for i, val in enumerate(row):
            col_widths[i] = max(col_widths[i], len(str(val)))
    
    header_str = " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(headers))
    sep_str = "-+-".join("-" * col_widths[i] for i in range(len(headers)))
    
    lines = [header_str, sep_str]
    for row in rows:
        lines.append(" | ".join(str(val).ljust(col_widths[i]) for i, val in enumerate(row)))
    return "\n".join(lines)


async def check_academia_user_exists(username):
    """Check if the Academia email exists without requiring a valid password."""
    try:
        async with httpx.AsyncClient(headers=HEADERS, follow_redirects=True, timeout=10.0) as client:
            payload = {
                'username': username,
                'password': 'dummy_check_password_12345',
                'client_portal': 'true',
                'portal': '10002227248',
                'servicename': 'ZohoCreator',
                'serviceurl': 'https://academia.srmist.edu.in/',
                'is_ajax': 'true',
                'grant_type': 'password',
                'service_language': 'en'
            }
            r = await client.post(LOGIN_URL, data=payload)
            data = json.loads(r.text)
            err = data.get('error', {})
            if isinstance(err, dict) and 'password' in err:
                return True
            msg = str(err.get('msg', '') if isinstance(err, dict) else err).lower()
            if 'invalid email' in msg or 'user does not exist' in msg or 'invalid username' in msg:
                return False
            if data.get('code') in ['HIP_REQUIRED', 'HIP_FAILED'] or 'cdigest' in data or 'data' in data:
                return True
            return False
    except Exception:
        return False


async def authenticate_portal(username, password):
    print("-> Loading Student Portal login page & captcha...")
    portal_session = PortalSession()
    await portal_session.load_captcha()
    
    if hasattr(portal_session, "captcha_bytes") and portal_session.captcha_bytes:
        captcha_file = Path("portal_captcha.png")
        captcha_file.write_bytes(portal_session.captcha_bytes)
        print(f"📸 Saved captcha image to '{captcha_file.resolve()}'")
        
    captcha_val = input("Enter Portal Captcha: ").strip()

    print("-> Authenticating with Student Portal...")
    login_res = await portal_session.login(username, password, captcha_val)

    if not login_res.get("ok"):
        reason = login_res.get("reason", "Unknown")
        msg = login_res.get("message", "Login failed")
        print(f"\n❌ Student Portal Login Failed ({reason}): {msg}")
        return None

    print("-> Student Portal authentication successful!")
    return PortalClient(login_res["cookies"])


async def fetch_portal_data(portal_client):
    print("-> Fetching Portal Profile, Attendance, Marks, Timetable & Calendar...")
    prof_html, att_html, tt_html, cal_html = await asyncio.gather(
        portal_client.get_profile_html(),
        portal_client.get_attendance_html(),
        portal_client.get_timetable_html(),
        portal_client.get_calendar_html()
    )

    profile = PortalProfileService.parse(prof_html) if prof_html else {}
    courses, monthly = PortalAttendanceService.parse(att_html) if att_html else ([], [])
    marks = await portal_client.get_marks_data(att_html=att_html)
    schedule, course_map = PortalTimetableService.parse(tt_html) if tt_html else ({}, {})
    cal_entries, day_order = CalendarService.parse_calendar(cal_html) if cal_html else ([], "-")

    return {
        "profile": profile,
        "attendance": courses,
        "monthly": monthly,
        "marks": marks,
        "timetable": schedule,
        "course_map": course_map,
        "calendar": cal_entries,
        "day_order": day_order
    }


async def fetch_academia_data(username, password):
    client = AcademiaClient(username, password)
    cdigest = None
    captcha = None

    while True:
        try:
            print("-> Authenticating with SRM Academia portal...")
            await client.authenticate(captcha=captcha, cdigest=cdigest)
            print("-> Academia authentication successful!\n")
            break
        except Exception as e:
            err_msg = str(e)
            try:
                err_data = json.loads(err_msg)
                if err_data.get("type") == "CAPTCHA_REQUIRED":
                    print(f"\n[CAPTCHA REQUIRED]: {err_data.get('message')}")
                    print(f"Captcha Image URL: {err_data.get('image')}")
                    cdigest = err_data.get("cdigest")
                    captcha = input("Enter Captcha value from URL above: ").strip()
                    continue
            except json.JSONDecodeError:
                pass
            
            print(f"\n❌ Academia Login Failed: {err_msg}")
            return None

    print("-> Fetching Profile, Timetable, Courses & Calendar from Academia...")
    res_prof, res_g1, res_g2, res_att, res_plan = await asyncio.gather(
        client.get_profile_html(),
        client.get_grid_html("Batch_1"),
        client.get_grid_html("batch_2"),
        client.get_attendance_html(),
        client.get_planner_html()
    )

    profile_html = res_prof if isinstance(res_prof, str) else None
    g1_html = res_g1 if isinstance(res_g1, str) else None
    g2_html = res_g2 if isinstance(res_g2, str) else None
    planner_html = res_plan if isinstance(res_plan, str) else None

    profile = ProfileService.parse_student_profile(profile_html) if profile_html else {}
    course_map = CourseService.get_course_map(profile_html) if profile_html else {}

    schedule = {}
    if profile and course_map:
        raw_batch = str(profile.get("batch", "1")).strip()
        actual_batch = raw_batch.split("/")[-1].strip() if "/" in raw_batch else raw_batch
        grid_html = g1_html if actual_batch == "1" else g2_html
        if grid_html:
            schedule = TimetableService.parse_unified_grid(grid_html, course_map)

    cal_entries, day_order = CalendarService.parse_calendar(planner_html) if planner_html else ([], "-")

    return {
        "profile": profile,
        "course_map": course_map,
        "timetable": schedule,
        "calendar": cal_entries,
        "day_order": day_order
    }


def render_unified_student_data(portal_data, academia_data):
    p_prof = portal_data.get("profile", {}) if portal_data else {}
    a_prof = academia_data.get("profile", {}) if academia_data else {}

    has_academia = bool(academia_data and a_prof)

    # 1. PERSONAL DETAILS (Academia if available, else Portal)
    print_header("PERSONAL DETAILS")
    prof = a_prof if (has_academia and a_prof.get("name")) else p_prof
    print(f" Name        : {prof.get('name', 'N/A')}")
    print(f" Reg No      : {prof.get('regNo', 'N/A')}")
    print(f" Program     : {prof.get('program', 'N/A')}")
    print(f" Department  : {prof.get('dept', 'N/A')}")
    print(f" Semester    : {prof.get('semester', 'N/A')}")
    print(f" Batch       : {prof.get('batch', 'N/A')}")
    print(f" Section     : {prof.get('section', 'N/A')}")

    # 2. ENROLLED COURSES (Academia if available, else Portal)
    print_header("ENROLLED COURSES")
    course_map = (academia_data.get("course_map") if has_academia else None) or (portal_data.get("course_map") if portal_data else {})
    if course_map:
        unique_courses = {}
        for slot, details in course_map.items():
            code = details['code']
            if code not in unique_courses:
                unique_courses[code] = details

        c_rows = []
        for code, details in unique_courses.items():
            c_rows.append([
                details.get("code", ""),
                details.get("name", "")[:35],
                details.get("type", ""),
                details.get("slot", ""),
                details.get("room", ""),
                details.get("credits", ""),
                details.get("faculty", "")[:25]
            ])
        print(format_table(["Code", "Course Name", "Type", "Slot", "Room", "Credits", "Faculty"], c_rows))
    else:
        print("No enrolled courses found.")

    # 3. ATTENDANCE SUMMARY & MONTHLY BREAKDOWN (Portal)
    print_header("ATTENDANCE SUMMARY")
    p_courses = portal_data.get("attendance", []) if portal_data else []
    p_monthly = portal_data.get("monthly", []) if portal_data else []
    if p_courses:
        att_rows = []
        for c in p_courses:
            pct = f"{c['percent']}%"
            att_rows.append([c["code"], c["title"][:32], c["conducted"], c["present"], c["absent"], pct])
        print(format_table(["Code", "Title", "Conducted", "Present", "Absent", "Attendance"], att_rows))
    else:
        print("No attendance summary found.")
    
    if p_monthly:
        print_header("MONTHLY ATTENDANCE BREAKDOWN")
        m_rows = []
        for m in p_monthly:
            m_rows.append([m["month"], m["present"], m["absent"]])
        print(format_table(["Month", "Present Days", "Absent Days"], m_rows))

    # 4. INTERNAL MARKS & COMPONENTS (Portal)
    print_header("INTERNAL MARKS & COMPONENTS")
    marks_data = portal_data.get("marks", []) if portal_data else []
    if marks_data:
        m_rows = []
        for m in marks_data:
            assess_str = ", ".join(f"{a['title']}:{a['marks']}/{a['total']}" for a in m.get("assessments", []))
            m_rows.append([m.get("courseCode", ""), m.get("title", "")[:30], m.get("performance", "N/A"), assess_str[:40]])
        print(format_table(["Code", "Course Title", "Score", "Component Marks Breakdown"], m_rows))
    else:
        print("No internal marks data found.")

    # 5. TIMETABLE SCHEDULE (Academia if available, else Portal)
    print_header("TIMETABLE SCHEDULE")
    schedule = (academia_data.get("timetable") if has_academia else None) or (portal_data.get("timetable") if portal_data else {})
    if schedule:
        for day_name, slots in schedule.items():
            print(f"\n📌 {day_name}:")
            t_rows = []
            for time_str, slot_info in slots.items():
                t_rows.append([
                    time_str,
                    slot_info.get("slot", ""),
                    slot_info.get("code", ""),
                    slot_info.get("course", "")[:30],
                    slot_info.get("room", "")
                ])
            print(format_table(["Time", "Slot", "Code", "Course", "Room"], t_rows))
    else:
        print("No timetable schedule found.")

    # 6. ACADEMIC CALENDAR & DAY ORDER (Portal first, fallback to Academia)
    p_cal = portal_data.get("calendar", []) if portal_data else []
    a_cal = academia_data.get("calendar", []) if academia_data else []
    
    cal_entries = p_cal if p_cal else a_cal
    day_order = (portal_data.get("day_order") if p_cal else (academia_data.get("day_order") if academia_data else "-")) or "-"

    print_header(f"ACADEMIC CALENDAR (Today's Day Order: {day_order})")
    if cal_entries:
        cal_rows = []
        for entry in cal_entries[:20]:
            cal_rows.append([
                entry.get("date", ""),
                entry.get("day", ""),
                entry.get("dayOrder", "-"),
                entry.get("description", "")[:40]
            ])
        print(format_table(["Date", "Day", "Day Order", "Description"], cal_rows))
    else:
        print("No academic calendar entries found.")


async def main():
    print_header("SRM STUDENT DASHBOARD CLIENT")

    # 1. Login to Portal (NetID, Password, Captcha)
    netid_input = input("\nEnter NetID: ").strip()
    if not netid_input:
        print("NetID cannot be empty.")
        return

    netid = netid_input.split("@")[0].strip()
    portal_password = getpass.getpass(f"Enter Portal Password for {netid}: ").strip()
    if not portal_password:
        print("Password cannot be empty.")
        return

    portal_client = await authenticate_portal(netid, portal_password)
    if not portal_client:
        print("\n❌ Student Portal login failed or account does not exist. Aborting.")
        return

    # Fetch Portal Data
    portal_data = await fetch_portal_data(portal_client)

    # 2. Check if Academia account exists for netid@srmist.edu.in
    academia_email = f"{netid}@srmist.edu.in"
    print(f"\n-> Checking if Academia account exists for '{academia_email}'...")
    academia_exists = await check_academia_user_exists(academia_email)

    academia_data = None
    if academia_exists:
        print(f"-> Academia account '{academia_email}' detected!")
        academia_password = getpass.getpass(f"Enter Academia Password for {academia_email}: ").strip()
        if academia_password:
            academia_data = await fetch_academia_data(academia_email, academia_password)
        else:
            print("⚠️ No Academia password provided. Proceeding with Student Portal data.")
    else:
        print(f"ℹ️ Academia account '{academia_email}' does not exist.")

    # Render Unified Data for the Student
    render_unified_student_data(portal_data, academia_data)

    print("\n✅ Execution complete.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nExited.")
