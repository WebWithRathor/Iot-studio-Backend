import type { Request, Response } from 'express';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '../../constants/cookie.constants';
import { accessCookieOptions, clearOptions, refreshCookieOptions } from '../../utils/cookie.util';

/** Tokens travel ONLY in HttpOnly cookies — never in response bodies. */
export const cookieService = {
  setAuthCookies(res: Response, tokens: { accessToken: string; refreshToken?: string }): void {
    res.cookie(ACCESS_TOKEN_COOKIE, tokens.accessToken, accessCookieOptions());
    if (tokens.refreshToken) res.cookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, refreshCookieOptions());
  },

  clearAuthCookies(res: Response): void {
    res.clearCookie(ACCESS_TOKEN_COOKIE, clearOptions(accessCookieOptions()));
    res.clearCookie(REFRESH_TOKEN_COOKIE, clearOptions(refreshCookieOptions()));
  },

  readAccessToken: (req: Request): string | undefined => {
    const v = (req.cookies as Record<string, unknown> | undefined)?.[ACCESS_TOKEN_COOKIE];
    return typeof v === 'string' && v.length < 4096 ? v : undefined;
  },

  readRefreshToken: (req: Request): string | undefined => {
    const v = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_TOKEN_COOKIE];
    return typeof v === 'string' && v.length < 4096 ? v : undefined;
  },
};
