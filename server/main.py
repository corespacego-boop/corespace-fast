import base64
import time
import asyncio
import os
import sys
import json
import hmac
import hashlib
import secrets
import logging
from pathlib import Path
from datetime import datetime
from contextlib import asynccontextmanager

server_dir = str(Path(__file__).resolve().parent)
if server_dir not in sys.path:
    sys.path.insert(0, server_dir)

import httpx
import uvicorn

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
from core.academia_client import AcademiaClient
from core.portal_client import PortalClient, PortalSession
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from models.schemas import Credentials, LoginCredentials, PortalCredentials
from services.marks_service import MarksService
from services.profile_service import ProfileService
from services.course_service import CourseService
from services.attendance_service import AttendanceService
from services.timetable_service import TimetableService
from services.portal_attendance_service import PortalAttendanceService
from services.portal_marks_service import PortalMarksService
from services.portal_timetable_service import PortalTimetableService
from services.portal_profile_service import PortalProfileService
from dotenv import load_dotenv
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

load_dotenv()
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env.local'))


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http_client = httpx.AsyncClient(timeout=10.0)
    yield
    await app.state.http_client.aclose()




def get_rate_limit_key(request: Request):
    return (
        request.headers.get("CF-Connecting-IP") or
        get_remote_address(request)
    )

limiter = Limiter(key_func=get_rate_limit_key)

_docs_enabled = os.getenv("ENV") == "development"
app = FastAPI(
    lifespan=lifespan,
    docs_url="/docs" if _docs_enabled else None,
    redoc_url="/redoc" if _docs_enabled else None,
    openapi_url="/openapi.json" if _docs_enabled else None,
)
app.state.limiter = limiter

@app.exception_handler(RateLimitExceeded)
async def custom_rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": "stop spamming blud"}
    )

_dev_origins = ["http://localhost:3000", "http://localhost:3001", "http://localhost:9002", "http://localhost:9001", "http://localhost:9000"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    max_age=86400,
)

app.add_middleware(GZipMiddleware, minimum_size=1000)

HMAC_SECRET = os.getenv("HMAC_SECRET", "")

def verify_request(sig_header: str, body: bytes) -> bool:
    if not HMAC_SECRET:
        return True
    try:
        parts = dict(p.split("=", 1) for p in sig_header.split(","))
        timestamp = int(parts["t"])
        received = parts["v1"]
        if abs(time.time() - timestamp) > 300:
            return False
        body_hash = hashlib.sha256(body).hexdigest()
        message = f"{timestamp}.{body_hash}".encode()
        expected = hmac.new(HMAC_SECRET.encode(), message, hashlib.sha256).hexdigest()
        return hmac.compare_digest(received, expected)
    except Exception:
        return False

@app.middleware("http")
async def security_middleware(request: Request, call_next):
    if request.method == "OPTIONS":
        return await call_next(request)

    if os.getenv("ENV") == "development":
        return await call_next(request)

    if request.url.path == "/feedback":
        return await call_next(request)

    body = await request.body()

    async def receive():
        return {"type": "http.request", "body": body}

    request._receive = receive

    sig = request.headers.get("X-Corespace-Sig", "")
    if not verify_request(sig, body):
        return PlainTextResponse(status_code=403, content="forbidden")

    return await call_next(request)

def get_now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3] + " IST"

@app.post("/feedback")
@limiter.limit("3/minute")
async def submit_feedback(request: Request):
    webhook_url = os.getenv("DISCORD_WEBHOOK", "")
    if not webhook_url:
        raise HTTPException(status_code=500, detail="not configured")
    body = await request.json()
    async with httpx.AsyncClient() as client:
        res = await client.post(webhook_url, json=body, timeout=8.0)
    if not res.is_success:
        raise HTTPException(status_code=502, detail="failed to deliver")
    return {"ok": True}

@app.get("/version")
async def get_version():
    return {"version": "2.0.0"}


@app.get("/pyq-proxy")
async def pyq_proxy(path: str, q: str = None, limit: int = None, cursor: str = None):
    """
    Proxy requests to the SRM PYQ API to bypass CORS.
    Example: /pyq-proxy?path=/v1/courses/21CSE253T/papers
    """
    target_base = "https://srm-pyq-api.onrender.com"
    target_url = f"{target_base}{path}"
    
    params = {}
    if q: params["q"] = q
    if limit: params["limit"] = limit
    if cursor: params["cursor"] = cursor

    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(target_url, params=params, timeout=10.0)
            return JSONResponse(
                status_code=response.status_code,
                content=response.json()
            )
        except Exception as e:
            print(f"[API] PYQ Proxy Error: {str(e)}")
            raise HTTPException(status_code=500, detail="Failed to fetch from PYQ API")

@app.post("/refresh")
@limiter.limit("3/minute")
async def refresh_data(creds: Credentials, request: Request):
    start_total = time.time()
    print(f"[API] Incoming REFRESH request for: {creds.username}", flush=True)
    try:
        if not creds.cookies and not creds.password:
            raise HTTPException(status_code=401, detail={"type": "SESSION_EXPIRED"})

        client = AcademiaClient(creds.username, creds.password, creds.cookies)
        if not creds.cookies:
            await client.authenticate(creds.captcha, creds.cdigest)

        res_prof, res_g1, res_g2, res_att = await asyncio.gather(
            client.get_profile_html(),
            client.get_grid_html("Batch_1"),
            client.get_grid_html("batch_2"),
            client.get_attendance_html()
        )
        profile_html = res_prof if isinstance(res_prof, str) else None
        g1_html = res_g1 if isinstance(res_g1, str) else None
        g2_html = res_g2 if isinstance(res_g2, str) else None
        att_html = res_att if isinstance(res_att, str) else None

        session_dead = (profile_html is None or profile_html == "CONCURRENT_ERROR") and (att_html is None or att_html == "CONCURRENT_ERROR")

        if session_dead and creds.password:
            print(f"{get_now()}\n  -> [AUTH] Session invalid or site glitch. Attempting re-auth...", flush=True)
            try:
                await client.authenticate(creds.captcha, creds.cdigest)
                res_prof, res_g1, res_g2, res_att = await asyncio.gather(
                    client.get_profile_html(),
                    client.get_grid_html("Batch_1"),
                    client.get_grid_html("batch_2"),
                    client.get_attendance_html()
                )
                profile_html = res_prof if isinstance(res_prof, str) else None
                g1_html = res_g1 if isinstance(res_g1, str) else None
                g2_html = res_g2 if isinstance(res_g2, str) else None
                att_html = res_att if isinstance(res_att, str) else None
                session_dead = (profile_html is None or profile_html == "CONCURRENT_ERROR") and (att_html is None or att_html == "CONCURRENT_ERROR")
            except Exception as e:
                err_msg = str(e)
                if "Invalid credentials" in err_msg or "check your username/password" in err_msg.lower():
                    raise HTTPException(status_code=401, detail="Invalid Credentials")
                raise HTTPException(status_code=503, detail="Academia is temporarily unavailable. Try again.")

        if session_dead:
            if not creds.password:
                raise HTTPException(status_code=401, detail={"type": "SESSION_EXPIRED"})
            print(f"{get_now()}\n  -> [AUTH] FAILED: Site returned no data after re-auth.", flush=True)
            raise HTTPException(status_code=503, detail="Academia returned no data. Site might be down.")

        attendance = AttendanceService.parse_attendance(att_html)
        marks = MarksService.parse_test_performance(att_html)
        profile = ProfileService.parse_student_profile(profile_html) if profile_html else None
        courses = CourseService.get_course_map(profile_html) if profile_html else None

        schedule = None
        if profile and courses:
            raw_batch = str(profile.get("batch", "1")).strip()
            actual_batch = raw_batch.split("/")[-1].strip() if "/" in raw_batch else raw_batch
            profile["batch"] = actual_batch
            grid_html = g1_html if actual_batch == "1" else g2_html
            if grid_html:
                schedule = TimetableService.parse_unified_grid(grid_html, courses)

        current_cookies = {c.name: c.value for c in client.session_handler.client.cookies.jar}
        print(f"[API] Refresh completed in {time.time() - start_total:.2f}s", flush=True)
        res_data = {
            "success": True,
            "attendance": attendance,
            "marks": marks,
            "cookies": current_cookies,
        }
        if profile:
            res_data["profile"] = profile
        if courses:
            res_data["courses"] = courses
        if schedule:
            res_data["schedule"] = schedule
        return res_data




    except (httpx.NetworkError, httpx.TimeoutException) as e:
        err_msg = str(e)
        print(f"{get_now()}\n  -> [API] NETWORK ERROR in /refresh: {err_msg}", flush=True)
        raise HTTPException(status_code=503, detail="Academia server is unreachable. Please try again later.")
    except HTTPException as e:
        raise e
    except Exception as e:
        err_msg = str(e)
        print(f"{get_now()}\n  -> [API] ERROR in /refresh: {err_msg}", flush=True)
        try:
            err_data = json.loads(err_msg)
            if isinstance(err_data, dict) and err_data.get("type") == "CAPTCHA_REQUIRED":
                raise HTTPException(status_code=401, detail=err_data)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail="Something went wrong while fetching data.")

@app.post("/login")
@limiter.limit("5/minute")
async def login(creds: LoginCredentials, request: Request):
    start_total = time.time()
    print(f"[API] Incoming login request for: {creds.username}", flush=True)
    try:
        client = AcademiaClient(creds.username, creds.password, creds.cookies)
        if not creds.cookies:
            await client.authenticate(creds.captcha, creds.cdigest)
            
        res_prof, res_g1, res_g2, res_att = await asyncio.gather(
            client.get_profile_html(),
            client.get_grid_html("Batch_1"),
            client.get_grid_html("batch_2"),
            client.get_attendance_html()
        )
        profile_html = res_prof if isinstance(res_prof, str) else None
        g1_html = res_g1 if isinstance(res_g1, str) else None
        g2_html = res_g2 if isinstance(res_g2, str) else None
        att_html = res_att if isinstance(res_att, str) else None

        session_dead = (profile_html is None or profile_html == "CONCURRENT_ERROR")

        if session_dead:
            print(f"{get_now()}\n  -> [AUTH] Re-authenticating...", flush=True)
            await client.authenticate(creds.captcha, creds.cdigest)
            res_prof, res_g1, res_g2, res_att = await asyncio.gather(
                client.get_profile_html(),
                client.get_grid_html("Batch_1"),
                client.get_grid_html("batch_2"),
                client.get_attendance_html()
            )
            profile_html = res_prof if isinstance(res_prof, str) else None
            g1_html = res_g1 if isinstance(res_g1, str) else None
            g2_html = res_g2 if isinstance(res_g2, str) else None
            att_html = res_att if isinstance(res_att, str) else None

        if not profile_html:
            print(f"{get_now()}\n  -> [ACADEMIA] INFO: Authenticated successfully, but profile page is not yet operational.", flush=True)
            raise HTTPException(status_code=503, detail="Academia is not fully operational yet.")

        profile = ProfileService.parse_student_profile(profile_html)
        course_map = CourseService.get_course_map(profile_html)
        
        raw_batch = str(profile.get("batch", "1")).strip()
        actual_batch = raw_batch.split("/")[-1].strip() if "/" in raw_batch else raw_batch
        profile["batch"] = actual_batch
        
        grid_html = g1_html if actual_batch == "1" else g2_html
        
        attendance = AttendanceService.parse_attendance(att_html)
        marks = MarksService.parse_test_performance(att_html)
        
        schedule = {}
        if grid_html:
            schedule = TimetableService.parse_unified_grid(grid_html, course_map)
            
        current_cookies = {c.name: c.value for c in client.session_handler.client.cookies.jar}
        print(f"[API] Login completed in {time.time() - start_total:.2f}s", flush=True)
        return {
            "success": True,
            "profile": profile,
            "attendance": attendance,
            "marks": marks,
            "schedule": schedule,
            "courses": course_map,
            "cookies": current_cookies,
        }
    except (httpx.NetworkError, httpx.TimeoutException) as e:
        err_msg = str(e)
        print(f"{get_now()}\n  -> [API] NETWORK ERROR in /login: {err_msg}", flush=True)
        raise HTTPException(status_code=503, detail="Academia server is unreachable. Please try again later.")
    except HTTPException as e:
        raise e
    except Exception as e:
        err_msg = str(e)
        print(f"{get_now()}\n  -> [API] ERROR in /login: {err_msg}", flush=True)
        try:
            err_data = json.loads(err_msg)
            if isinstance(err_data, dict) and err_data.get("type") == "CAPTCHA_REQUIRED":
                raise HTTPException(status_code=401, detail=err_data)
        except Exception:
            pass
        raise HTTPException(status_code=401, detail="Invalid Credentials")


_portal_captcha_sessions = {}


@app.post("/portal/captcha")
@limiter.limit("15/minute")
async def portal_captcha(request: Request):
    session = PortalSession()
    try:
        info = await session.load_captcha()
    except Exception as e:
        print(f"{get_now()}\n  -> [API] ERROR loading portal captcha: {e}", flush=True)
        raise HTTPException(status_code=503, detail="Portal unavailable right now.")
    sid = secrets.token_hex(8)
    _portal_captcha_sessions[sid] = session
    if len(_portal_captcha_sessions) > 50:
        keys_to_remove = list(_portal_captcha_sessions.keys())[:15]
        for k in keys_to_remove:
            old_sess = _portal_captcha_sessions.pop(k, None)
            if old_sess and hasattr(old_sess, "client"):
                try:
                    asyncio.create_task(old_sess.client.aclose())
                except Exception:
                    pass
    return {
        "session": sid,
        "cdigest": sid,
        "image": info.get("captcha_image"),
        "captcha_image": info.get("captcha_image"),
        **info
    }


@app.post("/portal/login")
@limiter.limit("15/minute")
async def portal_login(creds: PortalCredentials, request: Request):
    if creds.cookies:
        client = PortalClient(creds.cookies)
        att_html, marks, tt_html, prof_html = await asyncio.gather(
            client.get_attendance_html(),
            client.get_marks_data(),
            client.get_timetable_html(),
            client.get_profile_html()
        )
        if att_html is None:
            raise HTTPException(status_code=401, detail={"type": "SESSION_EXPIRED"})
        courses, monthly = await asyncio.to_thread(PortalAttendanceService.parse, att_html)
        schedule, course_map = PortalTimetableService.parse(tt_html) if tt_html else ({}, {})
        profile = PortalProfileService.parse(prof_html) if prof_html else None
        res = {
            "success": True,
            "isPortal": True,
            "attendance": courses,
            "monthly": monthly,
            "cookies": {c.name: c.value for c in client.client.cookies.jar},
        }
        if marks:
            res["marks"] = marks
        if schedule:
            res["schedule"] = schedule
        if course_map:
            res["courses"] = course_map
        if profile:
            res["profile"] = profile
        return res

    session = _portal_captcha_sessions.pop(creds.cdigest, None) if creds.cdigest else None
    if not session:
        session = PortalSession()
        try:
            await session.load_captcha()
        except Exception:
            raise HTTPException(status_code=503, detail="Portal unavailable right now.")

    netid = (creds.username or "").strip().split("@")[0]
    password = creds.password or ""
    captcha_val = creds.captcha
    login_res = None

    if captcha_val:
        try:
            login_res = await session.login(netid, password, captcha_val, telemetry=creds.telemetry)
        except (httpx.ConnectTimeout, httpx.ConnectError, httpx.ReadTimeout, httpx.ReadError) as e:
            print(f"{get_now()}\n  -> [API] Portal connection error in /portal/login: {e}", flush=True)
            raise HTTPException(status_code=503, detail="Student Portal is unreachable or timing out. Please try again later.")
        except Exception as e:
            print(f"{get_now()}\n  -> [API] ERROR in /portal/login: {e}", flush=True)
            raise HTTPException(status_code=401, detail={"type": "INVALID_CREDENTIALS", "message": "Invalid credentials"})

    if not login_res or not login_res.get("ok"):
        reason = login_res.get("reason", "wrong_captcha") if login_res else "wrong_captcha"
        msg = login_res.get("message") if login_res else None

        fresh_session = PortalSession()
        fresh_info = {}
        try:
            fresh_info = await fresh_session.load_captcha()
        except Exception:
            pass
        new_sid = secrets.token_hex(8)
        _portal_captcha_sessions[new_sid] = fresh_session

        if reason == "wrong_captcha":
            raise HTTPException(status_code=401, detail={
                "type": "WRONG_CAPTCHA",
                "message": msg or "Invalid captcha. Please enter the new one.",
                "cdigest": new_sid,
                "image": fresh_info.get("captcha_image"),
                "captcha_image": fresh_info.get("captcha_image")
            })
        elif reason == "account_locked":
            raise HTTPException(status_code=401, detail={
                "type": "ACCOUNT_LOCKED",
                "message": msg or "Your Student Portal account has been locked due to too many failed attempts.",
            })
        elif reason == "invalid_credentials":
            raise HTTPException(status_code=401, detail={
                "type": "INVALID_CREDENTIALS",
                "message": msg or "Invalid login credentials. Make sure you are using your Student Portal password!",
                "cdigest": new_sid,
                "image": fresh_info.get("captcha_image"),
                "captcha_image": fresh_info.get("captcha_image")
            })
        else:
            raise HTTPException(status_code=401, detail={
                "type": reason.upper(),
                "message": msg or "Login failed.",
                "cdigest": new_sid,
                "image": fresh_info.get("captcha_image"),
                "captcha_image": fresh_info.get("captcha_image")
            })

    client = PortalClient(login_res["cookies"])
    try:
        att_html, marks, tt_html, prof_html = await asyncio.gather(
            client.get_attendance_html(),
            client.get_marks_data(),
            client.get_timetable_html(),
            client.get_profile_html()
        )
    except Exception as e:
        print(f"  -> [PORTAL] Connect error fetching details after login: {e}", flush=True)
        att_html, marks, tt_html, prof_html = None, [], None, None
    courses, monthly = await asyncio.to_thread(PortalAttendanceService.parse, att_html) if att_html else ([], [])
    if courses and marks:
        mark_codes = {m.get("courseCode", "").strip().lower() for m in marks}
        for c in courses:
            c_code = c.get("code", "").strip()
            if c_code.lower() not in mark_codes:
                marks.append({
                    "courseCode": c_code,
                    "title": c.get("title", ""),
                    "type": "Internal",
                    "performance": "N/A",
                    "assessments": [],
                    "totalMarkGot": None,
                    "totalMaxMarks": None
                })
    schedule, course_map = PortalTimetableService.parse(tt_html) if tt_html else ({}, {})
    profile = PortalProfileService.parse(prof_html) if prof_html else None
    out = {
        "success": True,
        "isPortal": True,
        "attendance": courses,
        "monthly": monthly,
        "cookies": {c.name: c.value for c in client.client.cookies.jar},
    }
    if marks:
        out["marks"] = marks
    if schedule:
        out["schedule"] = schedule
    if course_map:
        out["courses"] = course_map
    if profile:
        out["profile"] = profile
    return out


@app.post("/portal/refresh")
@limiter.limit("60/minute")
async def portal_refresh(creds: PortalCredentials, request: Request):
    if not creds.cookies:
        raise HTTPException(status_code=401, detail={"type": "SESSION_EXPIRED"})
    client = PortalClient(creds.cookies)
    att_html, marks = await asyncio.gather(
        client.get_attendance_html(),
        client.get_marks_data()
    )
    if att_html is None:
        raise HTTPException(status_code=401, detail={"type": "SESSION_EXPIRED"})
    courses, monthly = await asyncio.to_thread(PortalAttendanceService.parse, att_html)
    if courses and marks:
        mark_codes = {m.get("courseCode", "").strip().lower() for m in marks}
        for c in courses:
            c_code = c.get("code", "").strip()
            if c_code.lower() not in mark_codes:
                marks.append({
                    "courseCode": c_code,
                    "title": c.get("title", ""),
                    "type": "Internal",
                    "performance": "N/A",
                    "assessments": [],
                    "totalMarkGot": None,
                    "totalMaxMarks": None
                })
    res = {
        "success": True,
        "isPortal": True,
        "attendance": courses,
        "monthly": monthly,
        "cookies": {c.name: c.value for c in client.client.cookies.jar},
    }
    if marks:
        res["marks"] = marks
    return res


_announcements_history = {
    "latest": {"id": None, "text": "", "image_url": None, "files": [], "created_at": None},
    "history": [],
    "last_fetched": 0
}

@app.get("/api/announcements")
async def get_announcements():
    now = time.time()
    if now - _announcements_history["last_fetched"] < 30 and _announcements_history["latest"]["id"] is not None:
        return _announcements_history

    bot_token = os.getenv("DISCORD_BOT_TOKEN", "")
    channel_id = os.getenv("DISCORD_CHANNEL_ID", "")
    if not bot_token or not channel_id:
        return _announcements_history

    headers = {"Authorization": f"Bot {bot_token}"}
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages?limit=10"
    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(url, headers=headers, timeout=5.0)
            if res.status_code == 200:
                msgs = res.json()
                if msgs and isinstance(msgs, list) and len(msgs) > 0:
                    history = []
                    for msg in msgs:
                        content = msg.get("content", "")
                        attachments = msg.get("attachments", [])
                        image_url = None
                        files = []
                        for att in attachments:
                            att_url = att.get("url", "")
                            content_type = att.get("content_type", "")
                            if content_type and "image" in content_type:
                                image_url = att_url
                            else:
                                files.append({"name": att.get("filename", "file"), "url": att_url})
                        history.append({
                            "id": msg.get("id"),
                            "text": content,
                            "image_url": image_url,
                            "files": files,
                            "created_at": msg.get("timestamp")
                        })
                    _announcements_history["latest"] = history[0]
                    _announcements_history["history"] = history
                    _announcements_history["last_fetched"] = now
    except Exception:
        pass

    return _announcements_history


from pydantic import BaseModel
from typing import Optional
from core.config import LOGIN_URL, HEADERS
from services.calendar_service import CalendarService
from fastapi.staticfiles import StaticFiles

class CheckAcademiaRequest(BaseModel):
    username: str

class UnifiedLoginRequest(BaseModel):
    netid: str
    portal_password: str
    captcha: str
    cdigest: str
    academia_password: Optional[str] = None


async def check_academia_user_exists(username: str) -> bool:
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


@app.post("/api/check-academia")
@limiter.limit("30/minute")
async def check_academia_endpoint(req: CheckAcademiaRequest, request: Request):
    netid = req.username.strip().split("@")[0]
    email = f"{netid}@srmist.edu.in"
    exists = await check_academia_user_exists(email)
    return {"email": email, "exists": exists}


_unified_auth_sessions = {}

class PortalCheckRequest(BaseModel):
    netid: str
    portal_password: str
    captcha: str
    cdigest: str

class AcademiaAuthRequest(BaseModel):
    session_token: str
    academia_password: str


@app.post("/api/portal-auth-check")
@limiter.limit("15/minute")
async def portal_auth_check_endpoint(req: PortalCheckRequest, request: Request):
    netid = req.netid.strip().split("@")[0]
    session = _portal_captcha_sessions.pop(req.cdigest, None) if req.cdigest else None
    if not session:
        session = PortalSession()
        try:
            await session.load_captcha()
        except Exception:
            raise HTTPException(status_code=503, detail="Portal unavailable right now.")

    login_res = None
    try:
        login_res = await session.login(netid, req.portal_password, req.captcha)
    except Exception as e:
        print(f"  -> [PORTAL AUTH CHECK] Login error: {e}", flush=True)

    if not login_res or not login_res.get("ok"):
        reason = login_res.get("reason", "wrong_captcha") if login_res else "wrong_captcha"
        msg = login_res.get("message") if login_res else None

        fresh_session = PortalSession()
        fresh_info = {}
        try:
            fresh_info = await fresh_session.load_captcha()
        except Exception:
            pass
        new_sid = secrets.token_hex(8)
        _portal_captcha_sessions[new_sid] = fresh_session

        raise HTTPException(status_code=401, detail={
            "type": reason.upper(),
            "message": msg or "Login failed.",
            "cdigest": new_sid,
            "image": fresh_info.get("captcha_image"),
            "captcha_image": fresh_info.get("captcha_image")
        })

    # Fetch Portal Data
    portal_client = PortalClient(login_res["cookies"])
    prof_html, att_html, tt_html, cal_html = await asyncio.gather(
        portal_client.get_profile_html(),
        portal_client.get_attendance_html(),
        portal_client.get_timetable_html(),
        portal_client.get_calendar_html()
    )
    p_profile = PortalProfileService.parse(prof_html) if prof_html else {}
    p_courses, p_monthly = await asyncio.to_thread(PortalAttendanceService.parse, att_html) if att_html else ([], [])
    p_marks = await portal_client.get_marks_data(att_html=att_html)
    p_schedule, p_coursemap = PortalTimetableService.parse(tt_html) if tt_html else ({}, {})
    p_calendar, p_day_order = CalendarService.parse_calendar(cal_html) if cal_html else ([], "-")

    portal_data = {
        "profile": p_profile,
        "courses": p_coursemap,
        "attendance": p_courses,
        "monthly": p_monthly,
        "marks": p_marks,
        "timetable": p_schedule,
        "calendar": p_calendar,
        "day_order": p_day_order
    }

    # Check Academia Account Existence
    academia_email = f"{netid}@srmist.edu.in"
    academia_exists = await check_academia_user_exists(academia_email)

    if not academia_exists:
        return {
            "success": True,
            "academia_exists": False,
            "dashboard_data": {
                "success": True,
                "has_academia": False,
                "profile": p_profile,
                "courses": p_coursemap,
                "attendance": p_courses,
                "monthly": p_monthly,
                "marks": p_marks,
                "timetable": p_schedule,
                "calendar": p_calendar,
                "day_order": p_day_order
            }
        }

    token = secrets.token_hex(16)
    _unified_auth_sessions[token] = {
        "netid": netid,
        "academia_email": academia_email,
        "portal_data": portal_data,
        "created_at": time.time()
    }

    # Clean up old sessions (>15 mins)
    now = time.time()
    for k in list(_unified_auth_sessions.keys()):
        if now - _unified_auth_sessions[k]["created_at"] > 900:
            _unified_auth_sessions.pop(k, None)

    return {
        "success": True,
        "academia_exists": True,
        "academia_email": academia_email,
        "session_token": token,
        "portal_data": portal_data
    }


@app.post("/api/academia-auth")
@limiter.limit("15/minute")
async def academia_auth_endpoint(req: AcademiaAuthRequest, request: Request):
    session_info = _unified_auth_sessions.pop(req.session_token, None)
    if not session_info:
        raise HTTPException(status_code=401, detail="Session expired or invalid. Please login again.")

    netid = session_info["netid"]
    academia_email = session_info["academia_email"]
    p_data = session_info["portal_data"]

    ac_client = AcademiaClient(academia_email, req.academia_password)
    a_data = None
    try:
        await ac_client.authenticate()
        res_prof, res_g1, res_g2, res_plan = await asyncio.gather(
            ac_client.get_profile_html(),
            ac_client.get_grid_html("Batch_1"),
            ac_client.get_grid_html("batch_2"),
            ac_client.get_planner_html()
        )
        a_profile_html = res_prof if isinstance(res_prof, str) else None
        g1_html = res_g1 if isinstance(res_g1, str) else None
        g2_html = res_g2 if isinstance(res_g2, str) else None
        planner_html = res_plan if isinstance(res_plan, str) else None

        a_prof = ProfileService.parse_student_profile(a_profile_html) if a_profile_html else {}
        a_coursemap = CourseService.get_course_map(a_profile_html) if a_profile_html else {}

        a_schedule = {}
        if a_prof and a_coursemap:
            raw_batch = str(a_prof.get("batch", "1")).strip()
            actual_batch = raw_batch.split("/")[-1].strip() if "/" in raw_batch else raw_batch
            grid_html = g1_html if actual_batch == "1" else g2_html
            if grid_html:
                a_schedule = TimetableService.parse_unified_grid(grid_html, a_coursemap)

        a_cal, a_day_order = CalendarService.parse_calendar(planner_html) if planner_html else ([], "-")

        a_data = {
            "profile": a_prof,
            "coursemap": a_coursemap,
            "schedule": a_schedule,
            "calendar": a_cal,
            "day_order": a_day_order
        }
    except Exception as e:
        print(f"  -> [ACADEMIA AUTH] Login error: {e}", flush=True)
        return {
            "success": True,
            "has_academia": False,
            "academia_error": "Failed to authenticate with Academia using provided password.",
            "profile": p_data.get("profile", {}),
            "courses": p_data.get("courses", {}),
            "attendance": p_data.get("attendance", []),
            "monthly": p_data.get("monthly", []),
            "marks": p_data.get("marks", []),
            "timetable": p_data.get("timetable", {}),
            "calendar": p_data.get("calendar", []),
            "day_order": p_data.get("day_order", "-")
        }

    has_academia = bool(a_data and a_data.get("profile"))
    profile = a_data["profile"] if (has_academia and a_data["profile"].get("name")) else p_data.get("profile", {})
    coursemap = (a_data.get("coursemap") if has_academia else None) or p_data.get("courses", {})
    schedule = (a_data.get("schedule") if has_academia else None) or p_data.get("timetable", {})
    calendar = p_data.get("calendar", []) if p_data.get("calendar") else (a_data.get("calendar", []) if a_data else [])
    day_order = p_data.get("day_order", "-") if p_data.get("calendar") else (a_data.get("day_order", "-") if a_data else "-")

    return {
        "success": True,
        "has_academia": has_academia,
        "profile": profile,
        "courses": coursemap,
        "attendance": p_data.get("attendance", []),
        "monthly": p_data.get("monthly", []),
        "marks": p_data.get("marks", []),
        "timetable": schedule,
        "calendar": calendar,
        "day_order": day_order
    }


frontend_dir = os.path.join(os.path.dirname(__file__), '..', 'frontend')
if os.path.exists(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")

