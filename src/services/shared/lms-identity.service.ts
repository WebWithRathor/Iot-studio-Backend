import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { loadEnv } from '../../config/env.config';
import { DEFAULT_ROLE } from '../../constants/roles.constants';
import { userDao, type UserRecord } from '../../dao/user.dao';
import { channel, traced } from '../../utils/logger.util';
import { auditLogService } from '../private/audit-log.service';
import { demoWorkspaceService } from './demo-workspace.service';

/**
 * Maps a Kokoon LMS identity to an IoT Studio account (contract A.3), for
 * both SSO and the server-to-server device API:
 *   1. an account already linked to this lmsUserId → that account
 *   2. else, ONLY when the LMS says the email is verified, an unlinked
 *      account with the same email is linked
 *   3. else a new account: role USER, default plan, no usable password
 * The LMS never grants or changes a role or a plan.
 */

export interface LmsIdentity {
  lmsUserId: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export type LmsIdentityProblem = 'disabled' | 'email_conflict';

export class LmsIdentityError extends Error {
  constructor(public readonly problem: LmsIdentityProblem) {
    super(problem === 'disabled' ? 'This IoT Studio account has been disabled.' : 'This email already belongs to another IoT Studio account that cannot be linked automatically.');
    this.name = 'LmsIdentityError';
  }
}

/** A random password nobody knows; `passwordSet: false` keeps password sign-in off anyway. */
const unusableHash = () => argon2.hash(randomBytes(32).toString('base64url'), { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });

const isDuplicate = (err: unknown) => (err as { code?: number }).code === 11000;

export const lmsIdentityService = {
  resolveUser: (id: LmsIdentity, ip?: string) =>
    traced('LmsIdentityService.resolveUser', async (): Promise<{ user: UserRecord; outcome: 'existing' | 'linked' | 'created' }> => {
      const email = id.email.trim().toLowerCase();
      const existing = await userDao.findByLmsUserId(id.lmsUserId);
      if (existing) {
        if (existing.status !== 'active') throw new LmsIdentityError('disabled');
        return { user: existing, outcome: 'existing' };
      }

      const byEmail = await userDao.findByEmail(email);
      if (byEmail) {
        if (!id.emailVerified || byEmail.lmsUserId) throw new LmsIdentityError('email_conflict');
        if (byEmail.status !== 'active') throw new LmsIdentityError('disabled');
        const linked = await userDao.linkLms(String(byEmail._id), id.lmsUserId);
        if (!linked) throw new LmsIdentityError('email_conflict'); // linked to another LMS id in the meantime
        await auditLogService.record({ action: 'lms.user.linked', outcome: 'success', actor: { id: String(linked._id), role: linked.role }, ip, metadata: { lmsUserId: id.lmsUserId } });
        return { user: linked, outcome: 'linked' };
      }

      let created: UserRecord;
      try {
        created = await userDao.createFromLms({ email, name: id.name.slice(0, 80), passwordHash: await unusableHash(), role: DEFAULT_ROLE, lmsUserId: id.lmsUserId });
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        // Two first-time requests raced: the other one created the account.
        const winner = await userDao.findByLmsUserId(id.lmsUserId);
        if (!winner) throw new LmsIdentityError('email_conflict');
        if (winner.status !== 'active') throw new LmsIdentityError('disabled');
        return { user: winner, outcome: 'existing' };
      }
      await auditLogService.record({ action: 'lms.user.created', outcome: 'success', actor: { id: String(created._id), role: created.role }, ip, metadata: { lmsUserId: id.lmsUserId } });
      if (loadEnv().DEMO_WORKSPACE_ON_SIGNUP) {
        try {
          await demoWorkspaceService.ensureFor(String(created._id));
        } catch (err) {
          channel('app').error('demo.workspace.failed', { userId: String(created._id), errorName: (err as Error).name });
        }
      }
      return { user: created, outcome: 'created' };
    }),
};
