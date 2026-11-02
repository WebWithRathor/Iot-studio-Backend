import { createHash, randomUUID } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { jwtConfig } from '../../config/jwt.config';
import { ERROR_CODES } from '../../constants/error-codes.constants';
import { isRole, type Role } from '../../constants/roles.constants';
import type { AccessTokenClaims, IssuedTokens, RefreshTokenClaims } from '../../types/auth.types';
import { unauthenticated } from '../../utils/error.util';

/**
 * JWT issue/verify. Access and refresh tokens use DIFFERENT secrets and a
 * `typ` claim, so one can never be used as the other. Issuer, audience,
 * algorithm and expiry are always enforced.
 */

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newSessionId = () => randomUUID();
export const newTokenId = () => randomUUID();

export function issueTokens(input: { userId: string; sid: string; jti: string; role: Role; tokenVersion: number }): IssuedTokens {
  const c = jwtConfig();
  const now = Math.floor(Date.now() / 1000);
  const accessClaims: AccessTokenClaims = { sub: input.userId, sid: input.sid, role: input.role, tv: input.tokenVersion, typ: 'access' };
  const refreshClaims: RefreshTokenClaims = { sub: input.userId, sid: input.sid, jti: input.jti, typ: 'refresh' };
  const accessToken = jwt.sign(accessClaims, c.accessSecret, { algorithm: c.algorithm, expiresIn: c.accessTtlSec, issuer: c.issuer, audience: c.audience });
  const refreshToken = jwt.sign(refreshClaims, c.refreshSecret, { algorithm: c.algorithm, expiresIn: c.refreshTtlSec, issuer: c.issuer, audience: c.audience });
  return { accessToken, refreshToken, accessExpiresAt: (now + c.accessTtlSec) * 1000, refreshExpiresAt: (now + c.refreshTtlSec) * 1000 };
}

/** Only issues a new access token (used in the refresh grace window). */
export function issueAccessToken(input: { userId: string; sid: string; role: Role; tokenVersion: number }): { accessToken: string; accessExpiresAt: number } {
  const c = jwtConfig();
  const claims: AccessTokenClaims = { sub: input.userId, sid: input.sid, role: input.role, tv: input.tokenVersion, typ: 'access' };
  const accessToken = jwt.sign(claims, c.accessSecret, { algorithm: c.algorithm, expiresIn: c.accessTtlSec, issuer: c.issuer, audience: c.audience });
  return { accessToken, accessExpiresAt: (Math.floor(Date.now() / 1000) + c.accessTtlSec) * 1000 };
}

function verify(token: string, secret: string, opts: { ignoreExpiration?: boolean } = {}): JwtPayload {
  const c = jwtConfig();
  try {
    const p = jwt.verify(token, secret, {
      algorithms: [c.algorithm],
      issuer: c.issuer,
      audience: c.audience,
      clockTolerance: c.clockToleranceSec,
      ignoreExpiration: opts.ignoreExpiration ?? false,
    });
    if (typeof p === 'string') throw new Error('unexpected string payload');
    return p;
  } catch (err) {
    if ((err as Error).name === 'TokenExpiredError') throw unauthenticated('Your session expired. Refreshing…', ERROR_CODES.TOKEN_EXPIRED);
    throw unauthenticated('Your session is invalid. Sign in again.');
  }
}

export function verifyAccessToken(token: string): AccessTokenClaims & { exp: number } {
  const p = verify(token, jwtConfig().accessSecret);
  if (p.typ !== 'access' || typeof p.sub !== 'string' || typeof p.sid !== 'string' || !isRole(p.role) || typeof p.tv !== 'number' || typeof p.exp !== 'number') {
    throw unauthenticated('Your session is invalid. Sign in again.');
  }
  return { sub: p.sub, sid: p.sid, role: p.role, tv: p.tv, typ: 'access', exp: p.exp };
}

export function verifyRefreshToken(token: string, opts: { ignoreExpiration?: boolean } = {}): RefreshTokenClaims {
  const p = verify(token, jwtConfig().refreshSecret, opts);
  if (p.typ !== 'refresh' || typeof p.sub !== 'string' || typeof p.sid !== 'string' || typeof p.jti !== 'string') {
    throw unauthenticated('Your session is invalid. Sign in again.');
  }
  return { sub: p.sub, sid: p.sid, jti: p.jti, typ: 'refresh' };
}
