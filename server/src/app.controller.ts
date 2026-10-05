import { Controller, Post, Body, HttpException, HttpStatus } from '@nestjs/common';
import { PortalService } from './services/portal.service';
import { AcademiaService } from './services/academia.service';
import * as crypto from 'crypto';

@Controller()
export class AppController {
  private unifiedAuthSessions = new Map<string, any>();

  constructor(
    private readonly portalService: PortalService,
    private readonly academiaService: AcademiaService,
  ) {}

  // Fetch Captcha
  @Post('portal/captcha')
  async getCaptcha(@Body() body: any) {
    return this.portalService.loadCaptcha(body?.session || body?.cdigest);
  }

  // Check if Academia user exists
  @Post('api/check-academia')
  async checkAcademia(@Body() body: { username: string }) {
    const netid = (body?.username || '').trim().split('@')[0];
    const email = `${netid}@srmist.edu.in`;
    const exists = await this.academiaService.checkAcademiaUserExists(email);
    return { email, exists };
  }

  // STEP 1: Portal Auth Check & Academia existence check
  @Post('api/portal-auth-check')
  async portalAuthCheck(@Body() body: any) {
    const { netid, portal_password, captcha, cdigest } = body;
    if (!netid || !portal_password || !captcha) {
      throw new HttpException('Missing required fields.', HttpStatus.BAD_REQUEST);
    }

    const loginRes = await this.portalService.login(netid, portal_password, captcha, cdigest);
    if (!loginRes.ok) {
      throw new HttpException(
        {
          type: (loginRes.reason || 'wrong_captcha').toUpperCase(),
          message: 'Portal Login failed. Invalid captcha or password.',
          cdigest: loginRes.fresh?.session || '',
          image: loginRes.fresh?.image || '',
          captcha_image: loginRes.fresh?.image || '',
        },
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Fetch Portal Data
    const portalData = await this.portalService.fetchPortalData(loginRes.cookies);

    // Check Academia Account Existence
    const academiaEmail = `${loginRes.netid}@srmist.edu.in`;
    const academiaExists = await this.academiaService.checkAcademiaUserExists(academiaEmail);

    if (!academiaExists) {
      return {
        success: true,
        academia_exists: false,
        dashboard_data: {
          success: true,
          has_academia: false,
          ...portalData,
        },
      };
    }

    const token = crypto.randomBytes(16).toString('hex');
    this.unifiedAuthSessions.set(token, {
      netid: loginRes.netid,
      academiaEmail,
      portalData,
      createdAt: Date.now(),
    });

    return {
      success: true,
      academia_exists: true,
      academia_email: academiaEmail,
      session_token: token,
      portal_data: portalData,
    };
  }

  // STEP 2: Academia Auth Submit
  @Post('api/academia-auth')
  async academiaAuth(@Body() body: { session_token: string; academia_password: string }) {
    const sessionInfo = this.unifiedAuthSessions.get(body.session_token);
    if (!sessionInfo) {
      throw new HttpException('Session expired or invalid. Please login again.', HttpStatus.UNAUTHORIZED);
    }

    this.unifiedAuthSessions.delete(body.session_token);
    const { academiaEmail, portalData } = sessionInfo;

    const academiaData = await this.academiaService.fetchAcademiaData(academiaEmail, body.academia_password);

    if (!academiaData) {
      return {
        success: true,
        has_academia: false,
        academia_error: 'Failed to authenticate with Academia using provided password.',
        ...portalData,
      };
    }

    const hasAcademia = Boolean(academiaData && academiaData.profile?.name);

    return {
      success: true,
      has_academia: hasAcademia,
      profile: hasAcademia ? academiaData.profile : portalData.profile,
      courses: hasAcademia ? academiaData.courses : portalData.courses,
      attendance: portalData.attendance,
      monthly: portalData.monthly,
      marks: portalData.marks,
      timetable: hasAcademia ? academiaData.timetable : portalData.timetable,
      calendar: portalData.calendar.length > 0 ? portalData.calendar : academiaData.calendar,
      day_order: portalData.day_order !== '-' ? portalData.day_order : academiaData.day_order,
    };
  }
}
