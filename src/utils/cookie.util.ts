import type { CookieOptions } from 'express';
import { jwtConfig } from '../config/jwt.config';

/** Cookie option builders — the only place cookie flags are decided. */
export function accessCookieOptions(): CookieOptions {
  const c = jwtConfig();
  return {
    httpOnly: true,
    secure: c.cookie.secure,
    sameSite: c.cookie.sameSite,
    domain: c.cookie.domain,
    path: c.cookie.accessPath,
    maxAge: c.accessTtlSec * 1000,
  };
}

export function refreshCookieOptions(): CookieOptions {
  const c = jwtConfig();
  return {
    httpOnly: true,
    secure: c.cookie.secure,
    sameSite: c.cookie.sameSite,
    domain: c.cookie.domain,
    path: c.cookie.refreshPath,
    maxAge: c.refreshTtlSec * 1000,
  };
}

/** Options for clearing: must match path/domain exactly, without maxAge. */
export function clearOptions(opts: CookieOptions): CookieOptions {
  const { maxAge: _m, expires: _e, ...rest } = opts;
  return rest;
}
