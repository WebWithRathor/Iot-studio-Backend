import type { Role } from '../constants/roles.constants';

/** Claims carried by the 10-minute access token. */
export interface AccessTokenClaims {
  sub: string; // user id
  sid: string; // refresh-session id the token was minted from
  role: Role;
  tv: number; // user tokenVersion at issue time
  typ: 'access';
}

/** Claims carried by the 7-day refresh token. Only accepted by /auth/refresh and /auth/logout. */
export interface RefreshTokenClaims {
  sub: string;
  sid: string;
  jti: string;
  typ: 'refresh';
}

/** The authenticated principal attached to `req.user`. */
export interface AuthUser {
  id: string;
  sessionId: string;
  role: Role;
  email: string;
  name: string;
  /** Access-token expiry (epoch ms) — open SSE streams are closed at this time. */
  exp: number;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}
