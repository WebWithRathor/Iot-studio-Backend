import jwt, { type JwtPayload } from 'jsonwebtoken';
import { z } from 'zod';

/**
 * Pure helpers for "Sign in with Kokoon LMS" (contract A, docs/LMS-INTEGRATION.md).
 * No I/O: replay protection (jti) and user resolution live in the auth service.
 */

export type SsoErrorCode = 'expired' | 'invalid' | 'replayed' | 'disabled' | 'unavailable';

export class LmsSsoError extends Error {
  constructor(
    public readonly code: SsoErrorCode,
    public readonly reason: string,
  ) {
    super(`LMS SSO rejected: ${reason}`);
    this.name = 'LmsSsoError';
  }
}

export interface LmsSsoClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  jti: string;
  iat: number;
  exp: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const claimsSchema = z.object({
  sub: z.string().min(1).max(128),
  email: z.string().trim().toLowerCase().email().max(254),
  email_verified: z.boolean().optional().default(false),
  name: z.string().trim().min(1).max(80),
  jti: z.string().regex(UUID, 'must be a UUID'),
  iat: z.number().int(),
  exp: z.number().int(),
});

export interface SsoVerifyOptions {
  secret: string;
  issuer: string;
  audience: string;
  clockSkewSec: number;
  maxLifetimeSec: number;
  /** Seconds since epoch; injectable for tests. */
  now?: number;
}

/** Verify an SSO token's signature, issuer, audience, expiry and claim shapes. Throws LmsSsoError. */
export function verifyLmsSsoToken(token: string, o: SsoVerifyOptions): LmsSsoClaims {
  if (!o.secret) throw new LmsSsoError('unavailable', 'sso_secret_missing');
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) throw new LmsSsoError('invalid', 'malformed_token');
  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, o.secret, {
      algorithms: ['HS256'],
      issuer: o.issuer,
      audience: o.audience,
      clockTolerance: o.clockSkewSec,
      clockTimestamp: o.now,
    }) as JwtPayload;
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'TokenExpiredError') throw new LmsSsoError('expired', 'token_expired');
    if (name === 'NotBeforeError') throw new LmsSsoError('invalid', 'token_not_yet_valid');
    throw new LmsSsoError('invalid', `token_${(err as Error).message.replace(/[^a-z]+/gi, '_').toLowerCase().slice(0, 40)}`);
  }
  const parsed = claimsSchema.safeParse(payload);
  if (!parsed.success) throw new LmsSsoError('invalid', `bad_claim_${parsed.error.issues[0]?.path.join('.') || 'unknown'}`);
  const c = parsed.data;
  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (c.exp - c.iat > o.maxLifetimeSec) throw new LmsSsoError('invalid', 'token_lifetime_too_long');
  if (c.iat > now + o.clockSkewSec) throw new LmsSsoError('invalid', 'token_issued_in_future');
  return { sub: c.sub, email: c.email, emailVerified: c.email_verified, name: c.name, jti: c.jti, iat: c.iat, exp: c.exp };
}

const ID = '[A-Za-z0-9_-]{1,64}';
const ALLOWED_NEXT = new RegExp(
  `^/(?:devices(?:/${ID})?|projects/${ID}(?:/(?:editor(?:/${ID})?|[a-z]{1,20}))?|plan|payments|console)?$`,
);

/**
 * Where to land after SSO: a known app (hash) route, or "/".
 * Rejects anything that could leave the app: other origins, "//", queries, odd characters.
 */
export function sanitizeNextRoute(next: unknown): string {
  if (typeof next !== 'string' || next.length > 200) return '/';
  const n = next.trim();
  if (!n.startsWith('/') || n.includes('//')) return '/';
  return ALLOWED_NEXT.test(n) ? n : '/';
}
