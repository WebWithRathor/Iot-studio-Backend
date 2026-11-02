import * as argon2 from 'argon2';
import { loadEnv } from '../../config/env.config';
import { jwtConfig } from '../../config/jwt.config';
import { lmsConfig } from '../../config/lms.config';
import { ERROR_CODES } from '../../constants/error-codes.constants';
import { DEFAULT_ROLE, isRole, type Role } from '../../constants/roles.constants';
import { refreshSessionDao } from '../../dao/refresh-session.dao';
import { userDao } from '../../dao/user.dao';
import type { AuthUser, ClientInfo, IssuedTokens } from '../../types/auth.types';
import type { UserDTO } from '../../types/user.types';
import { addSeconds } from '../../utils/date.util';
import { AppError, conflict, forbidden, unauthenticated } from '../../utils/error.util';
import { oid } from '../../utils/id.util';
import { LmsSsoError, verifyLmsSsoToken } from '../../utils/lms-sso.util';
import { channel, traced } from '../../utils/logger.util';
import { auditLogService } from '../private/audit-log.service';
import { demoWorkspaceService } from '../shared/demo-workspace.service';
import { encryptionService } from '../shared/encryption.service';
import { LmsIdentityError, lmsIdentityService } from '../shared/lms-identity.service';
import { toUserDTO } from '../shared/mappers';
import { realtimeService } from '../shared/realtime.service';
import { redisService } from '../shared/redis.service';
import { issueAccessToken, issueTokens, newSessionId, newTokenId, sha256, verifyAccessToken, verifyRefreshToken } from '../shared/token.service';

/**
 * Authentication.
 *   - passwords: Argon2id (OWASP 2023 parameters: 19 MiB, t=2, p=1)
 *   - access token: 10 min JWT in an HttpOnly cookie, validated on every
 *     request against the live session in Redis and the user's tokenVersion
 *   - refresh token: 7 day JWT in an HttpOnly cookie scoped to /auth,
 *     ROTATED on every use; presenting an already-rotated token (outside a
 *     10 s grace window for parallel tabs) is treated as theft and revokes
 *     the whole session
 */

const ARGON = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const LOCK_AFTER_FAILURES = 8;
const LOCK_MINUTES = 15;
const REFRESH_GRACE_MS = 10_000;
let dummyHash: Promise<string> | null = null;

export const hashPassword = (pw: string) => argon2.hash(pw, ARGON);

async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

/** Spend the same time on unknown emails as on wrong passwords (no user enumeration by timing). */
async function burnTime(pw: string) {
  dummyHash ??= hashPassword('kokoon-timing-equaliser-not-a-password');
  await verifyPassword(await dummyHash, pw);
}

async function createSession(user: { _id: unknown; role: Role; tokenVersion: number }, client: ClientInfo): Promise<IssuedTokens & { sid: string }> {
  const userId = String(user._id);
  const sid = newSessionId();
  const jti = newTokenId();
  const tokens = issueTokens({ userId, sid, jti, role: user.role, tokenVersion: user.tokenVersion });
  const ttl = jwtConfig().refreshTtlSec;
  await redisService.putSession(sid, { userId, jtiHash: sha256(jti) }, ttl);
  await refreshSessionDao.create({
    sid,
    userId: oid(userId),
    currentJtiHash: sha256(jti),
    clientInfoEnc: encryptionService.encryptJson({ ip: client.ip ?? null, userAgent: client.userAgent?.slice(0, 300) ?? null }),
    expiresAt: addSeconds(new Date(), ttl),
  });
  return { ...tokens, sid };
}

async function revokeSession(sid: string, reason: string) {
  await Promise.allSettled([redisService.deleteSessions([sid]), refreshSessionDao.revoke(sid, reason)]);
  realtimeService.closeSession(sid);
}

/** Revoke every session of a user (role change, disable, password change, reuse). */
export async function revokeAllSessions(userId: string, reason: string, exceptSid?: string): Promise<number> {
  const sids = (await refreshSessionDao.revokeAllForUser(userId, reason)).filter((s) => s !== exceptSid);
  await redisService.deleteSessions(sids);
  await redisService.dropUserAuth(userId);
  sids.forEach((s) => realtimeService.closeSession(s));
  if (!exceptSid) realtimeService.closeUser(userId);
  return sids.length;
}

/** Contract A.3 — see authService.loginWithLms. */
async function lmsSsoLogin(input: { token: unknown; origin: string | undefined }, client: ClientInfo) {
  const cfg = lmsConfig();
  if (!cfg.enabled) throw new LmsSsoError('unavailable', 'integration_disabled');
  // The form must come from the LMS (blocks "login CSRF" from other sites). `Origin: null` only in development.
  if (input.origin && input.origin !== cfg.origin && !(input.origin === 'null' && cfg.allowNullOriginSso)) throw new LmsSsoError('invalid', 'origin_not_lms');
  const token = typeof input.token === 'string' ? input.token : '';
  const claims = verifyLmsSsoToken(token, { secret: cfg.ssoSecret, issuer: cfg.ssoIssuer, audience: cfg.ssoAudience, clockSkewSec: cfg.ssoClockSkewSec, maxLifetimeSec: cfg.ssoMaxLifetimeSec });
  let firstUse: boolean;
  try {
    firstUse = await redisService.claimSsoJti(claims.jti, cfg.ssoMaxLifetimeSec + 2 * cfg.ssoClockSkewSec);
  } catch {
    throw new LmsSsoError('unavailable', 'session_store_unavailable');
  }
  if (!firstUse) throw new LmsSsoError('replayed', 'jti_reused');
  let resolved;
  try {
    resolved = await lmsIdentityService.resolveUser({ lmsUserId: claims.sub, email: claims.email, emailVerified: claims.emailVerified, name: claims.name }, client.ip);
  } catch (err) {
    if (err instanceof LmsIdentityError) throw new LmsSsoError(err.problem === 'disabled' ? 'disabled' : 'invalid', err.problem);
    throw err;
  }
  const id = String(resolved.user._id);
  await userDao.recordLoginSuccess(id);
  const tokens = await createSession({ _id: resolved.user._id, role: resolved.user.role, tokenVersion: resolved.user.tokenVersion ?? 0 }, client);
  await auditLogService.record({ action: 'lms.sso.login', outcome: 'success', actor: { id, role: resolved.user.role }, ip: client.ip, metadata: { lmsUserId: claims.sub, account: resolved.outcome } });
  return { user: toUserDTO(resolved.user), tokens };
}

export const authService = {
  config: () => {
    const e = loadEnv();
    const lms = lmsConfig();
    return {
      registrationEnabled: e.REGISTRATION_ENABLED,
      demoWorkspaceOnSignup: e.DEMO_WORKSPACE_ON_SIGNUP,
      mqttMode: e.MQTT_MODE,
      lmsSso: { enabled: lms.enabled && Boolean(lms.ssoStartUrl), startUrl: lms.enabled ? lms.ssoStartUrl : null },
    };
  },

  /**
   * "Sign in with Kokoon LMS" (contract A): verify the LMS-signed one-time
   * token, burn its jti, resolve/create the account and open a normal session.
   * Throws LmsSsoError with the code the login page shows.
   */
  loginWithLms: (input: { token: unknown; origin: string | undefined }, client: ClientInfo) =>
    traced('AuthService.loginWithLms', async () => {
      try {
        return await lmsSsoLogin(input, client);
      } catch (err) {
        const reason = err instanceof LmsSsoError ? err.reason : 'internal_error';
        await auditLogService.record({ action: 'lms.sso.rejected', outcome: 'denied', ip: client.ip, metadata: { reason } }).catch(() => undefined);
        if (err instanceof LmsSsoError) throw err;
        channel('auth').error('lms.sso.failed', { errorName: (err as Error).name });
        throw new LmsSsoError('unavailable', reason);
      }
    }),


  register: (input: { name: string; email: string; password: string }, client: ClientInfo) =>
    traced('AuthService.register', async () => {
      const e = loadEnv();
      if (!e.REGISTRATION_ENABLED) throw new AppError(403, ERROR_CODES.REGISTRATION_DISABLED, 'Self-registration is turned off. Ask an administrator for an account.');
      if (await userDao.findByEmail(input.email)) throw conflict('An account with this email already exists. Sign in instead.', ERROR_CODES.DUPLICATE);
      // Role is ALWAYS the default — never taken from the request.
      const user = await userDao.create({ email: input.email, name: input.name, passwordHash: await hashPassword(input.password), role: DEFAULT_ROLE });
      await auditLogService.record({ action: 'auth.register', outcome: 'success', actor: { id: String(user._id), role: user.role }, ip: client.ip });
      if (e.DEMO_WORKSPACE_ON_SIGNUP) {
        try {
          await demoWorkspaceService.ensureFor(String(user._id));
        } catch (err) {
          channel('app').error('demo.workspace.failed', { userId: String(user._id), errorName: (err as Error).name });
        }
      }
      const tokens = await createSession({ _id: user._id, role: user.role, tokenVersion: user.tokenVersion ?? 0 }, client);
      return { user: toUserDTO(user), tokens };
    }),

  login: (input: { email: string; password: string }, client: ClientInfo) =>
    traced('AuthService.login', async () => {
      const user = await userDao.findByEmailWithSecrets(input.email);
      if (!user) {
        await burnTime(input.password);
        await auditLogService.record({ action: 'auth.login', outcome: 'failure', ip: client.ip, metadata: { reason: 'unknown_email' } });
        throw unauthenticated('Email or password is incorrect.', ERROR_CODES.INVALID_CREDENTIALS);
      }
      const id = String(user._id);
      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        await burnTime(input.password);
        await auditLogService.record({ action: 'auth.login.locked', outcome: 'denied', actor: { id }, ip: client.ip });
        throw unauthenticated(`Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.`, ERROR_CODES.INVALID_CREDENTIALS);
      }
      if (user.passwordSet === false) {
        // LMS-created account without a password of its own: only "Sign in with Kokoon LMS" works.
        await burnTime(input.password);
        await auditLogService.record({ action: 'auth.login', outcome: 'failure', actor: { id }, ip: client.ip, metadata: { reason: 'no_password_lms_account' } });
        throw unauthenticated('Email or password is incorrect.', ERROR_CODES.INVALID_CREDENTIALS);
      }
      if (!(await verifyPassword(user.passwordHash, input.password))) {
        const { locked } = await userDao.recordLoginFailure(id, LOCK_AFTER_FAILURES, LOCK_MINUTES);
        await auditLogService.record({ action: 'auth.login', outcome: 'failure', actor: { id }, ip: client.ip, metadata: { reason: 'bad_password', locked } });
        throw unauthenticated('Email or password is incorrect.', ERROR_CODES.INVALID_CREDENTIALS);
      }
      if (user.status !== 'active') {
        await auditLogService.record({ action: 'auth.login', outcome: 'denied', actor: { id, role: user.role }, ip: client.ip, metadata: { reason: 'disabled' } });
        throw forbidden('This account has been disabled. Contact an administrator.', ERROR_CODES.ACCOUNT_DISABLED);
      }
      if (argon2.needsRehash(user.passwordHash, ARGON)) await userDao.setPasswordHash(id, await hashPassword(input.password)).catch(() => undefined);
      await userDao.recordLoginSuccess(id);
      const tokens = await createSession(user, client);
      await auditLogService.record({ action: 'auth.login', outcome: 'success', actor: { id, role: user.role }, ip: client.ip });
      const fresh = await userDao.findById(id);
      return { user: toUserDTO(fresh ?? user), tokens };
    }),

  /** Exchange a refresh token for a new pair (rotation). */
  refresh: (refreshToken: string | undefined, client: ClientInfo) =>
    traced('AuthService.refresh', async (): Promise<{ accessToken: string; refreshToken?: string }> => {
      if (!refreshToken) throw unauthenticated('Sign in to continue.');
      const claims = verifyRefreshToken(refreshToken);
      const session = await redisService.getSession(claims.sid);
      if (!session || session.userId !== claims.sub) throw unauthenticated('Your session has ended. Sign in again.', ERROR_CODES.SESSION_REVOKED);
      const user = await userDao.findAuthState(claims.sub);
      if (!user || user.status !== 'active') {
        await revokeSession(claims.sid, 'account_disabled');
        throw unauthenticated('Your session has ended. Sign in again.', ERROR_CODES.SESSION_REVOKED);
      }
      const presented = sha256(claims.jti);
      const nextJti = newTokenId();
      const outcome = await redisService.rotateSession(claims.sid, presented, sha256(nextJti), REFRESH_GRACE_MS);
      if (outcome === 0) {
        // A refresh token that was already rotated away is being replayed → assume theft.
        await revokeSession(claims.sid, 'reuse_detected');
        await auditLogService.record({ action: 'auth.refresh.reuse', outcome: 'denied', actor: { id: claims.sub }, ip: client.ip, metadata: { sid: claims.sid } });
        throw unauthenticated('Your session was ended for security reasons. Sign in again.', ERROR_CODES.SESSION_REVOKED);
      }
      const role = user.role;
      if (outcome === 2) {
        // Parallel tab presented the previous token within the grace window: new access token only.
        return { accessToken: issueAccessToken({ userId: claims.sub, sid: claims.sid, role, tokenVersion: user.tokenVersion }).accessToken };
      }
      void refreshSessionDao.rotate(claims.sid, presented, sha256(nextJti)).catch(() => undefined);
      const t = issueTokens({ userId: claims.sub, sid: claims.sid, jti: nextJti, role, tokenVersion: user.tokenVersion });
      return { accessToken: t.accessToken, refreshToken: t.refreshToken };
    }),

  logout: (input: { refreshToken?: string; accessToken?: string; user?: AuthUser }) =>
    traced('AuthService.logout', async () => {
      let sid = input.user?.sessionId;
      let userId = input.user?.id;
      if (!sid && input.refreshToken) {
        try {
          const c = verifyRefreshToken(input.refreshToken, { ignoreExpiration: true });
          sid = c.sid;
          userId = c.sub;
        } catch {
          /* invalid token: nothing to revoke */
        }
      }
      if (!sid && input.accessToken) {
        try {
          const c = verifyAccessToken(input.accessToken);
          sid = c.sid;
          userId = c.sub;
        } catch {
          /* ignore */
        }
      }
      if (sid) {
        await revokeSession(sid, 'logout');
        await auditLogService.record({ action: 'auth.logout', outcome: 'success', actor: userId ? { id: userId } : null });
      }
    }),

  /**
   * Validate an access token for a request. Fails closed: if Redis is
   * unreachable this throws 503 rather than skipping the revocation check.
   */
  async resolveAccessToken(token: string): Promise<AuthUser> {
    const claims = verifyAccessToken(token);
    const [alive, cached] = await Promise.all([redisService.sessionExists(claims.sid), redisService.getUserAuth(claims.sub)]);
    if (!alive) throw unauthenticated('Your session has ended. Sign in again.', ERROR_CODES.SESSION_REVOKED);
    let state = cached;
    if (!state) {
      const u = await userDao.findAuthState(claims.sub);
      if (!u) throw unauthenticated('Your session has ended. Sign in again.', ERROR_CODES.SESSION_REVOKED);
      state = { role: u.role, status: u.status, tokenVersion: u.tokenVersion, email: u.email, name: u.name };
      await redisService.setUserAuth(claims.sub, state);
    }
    if (state.status !== 'active') throw unauthenticated('This account has been disabled.', ERROR_CODES.ACCOUNT_DISABLED);
    if (state.tokenVersion !== claims.tv || !isRole(state.role)) throw unauthenticated('Your permissions changed. Sign in again.', ERROR_CODES.SESSION_REVOKED);
    return { id: claims.sub, sessionId: claims.sid, role: state.role, email: state.email, name: state.name, exp: claims.exp * 1000 };
  },

  me: (userId: string) =>
    traced('AuthService.me', async (): Promise<UserDTO> => {
      const u = await userDao.findById(userId);
      if (!u) throw unauthenticated();
      return toUserDTO(u);
    }),
};
