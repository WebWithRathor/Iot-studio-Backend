import { loadEnv } from './env.config';
import { REFRESH_COOKIE_SUBPATH } from '../constants/cookie.constants';

/**
 * Token + cookie policy, centralised:
 *   access_token  — 10 minutes, HttpOnly, path = API base
 *   refresh_token — 7 days,     HttpOnly, path = API base + /auth (never sent to other routes)
 */
export function jwtConfig() {
  const e = loadEnv();
  return {
    accessSecret: e.JWT_ACCESS_SECRET,
    refreshSecret: e.JWT_REFRESH_SECRET,
    issuer: e.JWT_ISSUER,
    audience: e.JWT_AUDIENCE,
    accessTtlSec: e.ACCESS_TOKEN_TTL,
    refreshTtlSec: e.REFRESH_TOKEN_TTL,
    algorithm: 'HS256' as const,
    clockToleranceSec: 5,
    cookie: {
      secure: e.COOKIE_SECURE,
      sameSite: e.COOKIE_SAME_SITE,
      domain: e.COOKIE_DOMAIN,
      accessPath: e.API_BASE_PATH,
      refreshPath: `${e.API_BASE_PATH}${REFRESH_COOKIE_SUBPATH}`,
    },
  };
}
