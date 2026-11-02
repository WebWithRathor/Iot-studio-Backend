import type { Request, Response } from 'express';
import type { z } from 'zod';
import { loadEnv } from '../../config/env.config';
import { jwtConfig } from '../../config/jwt.config';
import { authService } from '../../services/public/auth.service';
import { cookieService } from '../../services/shared/cookie.service';
import type { ClientInfo } from '../../types/auth.types';
import { sendCreated, sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import { LmsSsoError, sanitizeNextRoute } from '../../utils/lms-sso.util';
import type { loginBody, registerBody } from '../../validations/public/auth.validation';

export const clientInfo = (req: Request): ClientInfo => ({ ip: req.ip, userAgent: req.get('user-agent') ?? undefined });

/** Tokens are set as HttpOnly cookies and NEVER included in the JSON body. */
export const authController = {
  config: asyncHandler(async (req, res) => sendSuccess(req, res, authService.config())),

  register: asyncHandler(async (req: Request, res: Response) => {
    const body = req.validated.body as z.infer<typeof registerBody>;
    const { user, tokens } = await authService.register(body, clientInfo(req));
    cookieService.setAuthCookies(res, tokens);
    sendCreated(req, res, { user, session: { accessExpiresAt: tokens.accessExpiresAt } }, 'Account created');
  }),

  login: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof loginBody>;
    const { user, tokens } = await authService.login(body, clientInfo(req));
    cookieService.setAuthCookies(res, tokens);
    sendSuccess(req, res, { user, session: { accessExpiresAt: tokens.accessExpiresAt } }, { message: 'Signed in' });
  }),

  refresh: asyncHandler(async (req, res) => {
    try {
      const tokens = await authService.refresh(cookieService.readRefreshToken(req), clientInfo(req));
      cookieService.setAuthCookies(res, tokens);
      sendSuccess(req, res, { refreshed: true, accessExpiresAt: Date.now() + jwtConfig().accessTtlSec * 1000 });
    } catch (err) {
      cookieService.clearAuthCookies(res);
      throw err;
    }
  }),

  logout: asyncHandler(async (req, res) => {
    await authService.logout({ refreshToken: cookieService.readRefreshToken(req), accessToken: cookieService.readAccessToken(req), user: req.user });
    cookieService.clearAuthCookies(res);
    sendSuccess(req, res, { signedOut: true }, { message: 'Signed out' });
  }),

  /**
   * POST /auth/lms/sso — top-level form POST from the Kokoon LMS (contract A).
   * Mounted in app.ts before the JSON parser and the X-Requested-With CSRF
   * rule: it is authenticated by the signed one-time token instead.
   * Always answers with a 303 redirect into the app, never with JSON.
   */
  lmsSso: asyncHandler(async (req, res) => {
    const frontend = loadEnv().FRONTEND_URL.replace(/\/+$/, '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const next = sanitizeNextRoute(body.next);
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    try {
      const { tokens } = await authService.loginWithLms({ token: body.token, origin: req.get('origin') }, clientInfo(req));
      cookieService.setAuthCookies(res, tokens);
      res.redirect(303, `${frontend}/#${next}`);
    } catch (err) {
      const code = err instanceof LmsSsoError ? err.code : 'unavailable';
      res.redirect(303, `${frontend}/#/login?sso_error=${code}`);
    }
  }),

  me: asyncHandler(async (req, res) => sendSuccess(req, res, { user: await authService.me(req.user!.id), session: { accessExpiresAt: req.user!.exp } })),
};
