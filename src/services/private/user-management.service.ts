import { DEFAULT_PLAN, type Plan } from '../../constants/plans.constants';
import type { Role } from '../../constants/roles.constants';
import { ERROR_CODES } from '../../constants/error-codes.constants';
import { ROLES } from '../../constants/roles.constants';
import { deviceDao } from '../../dao/device.dao';
import { projectDao } from '../../dao/project.dao';
import { refreshSessionDao } from '../../dao/refresh-session.dao';
import { userDao } from '../../dao/user.dao';
import type { AuthUser } from '../../types/auth.types';
import type { Page } from '../../types/common.types';
import type { ManagedUserDTO } from '../../types/user.types';
import { toEpoch } from '../../utils/date.util';
import { AppError, forbidden, notFound } from '../../utils/error.util';
import { traced } from '../../utils/logger.util';
import { escapeRegex } from '../../validations/shared/common.validation';
import { revokeAllSessions } from '../public/auth.service';
import { authorizationService } from '../shared/authorization.service';
import { encryptionService } from '../shared/encryption.service';
import { toUserDTO } from '../shared/mappers';
import { redisService } from '../shared/redis.service';
import { allowanceOf, tokenWallet } from '../shared/token-wallet.service';
import { auditLogService } from './audit-log.service';

const toManaged = (u: Parameters<typeof toUserDTO>[0], counts?: { projects?: number }): ManagedUserDTO => ({
  ...toUserDTO(u),
  updatedAt: toEpoch(u.updatedAt),
  projectCount: counts?.projects,
  bonusTokens: u.bonusTokens ?? 0,
  lmsUserId: u.lmsUserId ?? null,
  tokenAllowance: allowanceOf(u.plan, u.bonusTokens),
});

async function loadTarget(id: string) {
  const u = await userDao.findById(id);
  if (!u) throw notFound('User');
  return u;
}

async function deny(actor: AuthUser, action: 'user.role.change' | 'user.status.change' | 'user.sessions.revoke', targetId: string, reason: string): Promise<never> {
  await auditLogService.record({ action, outcome: 'denied', actor: { id: actor.id, role: actor.role }, target: { type: 'user', id: targetId }, metadata: { reason } });
  throw forbidden(reason);
}

export const userManagementService = {
  list: (q: { q?: string; role?: Role; status?: 'active' | 'disabled'; page: number; pageSize: number; sort: { field: string; direction: 1 | -1 } }) =>
    traced('UserManagementService.list', async (): Promise<Page<ManagedUserDTO>> => {
      const page = await userDao.paginate({ q: q.q ? escapeRegex(q.q) : undefined, role: q.role, status: q.status }, q.page, q.pageSize, q.sort);
      const counts = await projectDao.countByOwners(page.items.map((u) => String(u._id)));
      return { ...page, items: page.items.map((u) => toManaged(u, { projects: counts.get(String(u._id)) ?? 0 })) };
    }),

  get: (id: string) =>
    traced('UserManagementService.get', async () => {
      const u = await loadTarget(id);
      const [projects, devices, tokens] = await Promise.all([projectDao.countOwned(id), deviceDao.countOwned(id), tokenWallet.state(id)]);
      return { ...toManaged(u, { projects }), deviceCount: devices, tokensUsed: tokens.used };
    }),

  /**
   * Set a user's plan and/or bonus tokens. Plans are not privileges (no
   * session revocation), but every change is audited. Lowering a budget
   * below what the user has built keeps their work; they just cannot add more.
   */
  changePlan: (actor: AuthUser, id: string, input: { plan?: Plan; bonusTokens?: number; reason?: string }) =>
    traced('UserManagementService.changePlan', async (): Promise<ManagedUserDTO> => {
      const target = await loadTarget(id);
      const set: { plan?: Plan; bonusTokens?: number } = {};
      if (input.plan !== undefined) set.plan = input.plan;
      if (input.bonusTokens !== undefined) set.bonusTokens = input.bonusTokens;
      const updated = await userDao.setPlan(id, set);
      await auditLogService.record({
        action: 'plan.change', outcome: 'success', actor: { id: actor.id, role: actor.role }, target: { type: 'user', id },
        metadata: { fromPlan: target.plan ?? DEFAULT_PLAN, toPlan: updated!.plan ?? DEFAULT_PLAN, fromBonus: target.bonusTokens ?? 0, toBonus: updated!.bonusTokens ?? 0, reason: input.reason },
      });
      const tokens = await tokenWallet.state(id);
      return { ...toManaged(updated!), tokensUsed: tokens.used };
    }),

  /** Role change: hierarchy rules, last-super-admin guard, then every session of the target is revoked. */
  changeRole: (actor: AuthUser, id: string, role: Role, reason?: string) =>
    traced('UserManagementService.changeRole', async (): Promise<ManagedUserDTO> => {
      const target = await loadTarget(id);
      const decision = authorizationService.canAssignRole({ id: actor.id, role: actor.role }, { id, role: target.role }, role);
      if (!decision.ok) return deny(actor, 'user.role.change', id, decision.reason!);
      if (target.role === ROLES.SUPER_ADMIN && role !== ROLES.SUPER_ADMIN && (await userDao.countByRoleExact(ROLES.SUPER_ADMIN)) <= 1) {
        return deny(actor, 'user.role.change', id, 'The last super admin cannot be demoted.');
      }
      if (target.role === role) return toManaged(target);
      const updated = await userDao.setRole(id, role);
      const revoked = await revokeAllSessions(id, 'role_changed');
      await auditLogService.record({ action: 'user.role.change', outcome: 'success', actor: { id: actor.id, role: actor.role }, target: { type: 'user', id }, metadata: { from: target.role, to: role, reason, sessionsRevoked: revoked } });
      return toManaged(updated!);
    }),

  changeStatus: (actor: AuthUser, id: string, status: 'active' | 'disabled', reason?: string) =>
    traced('UserManagementService.changeStatus', async (): Promise<ManagedUserDTO> => {
      const target = await loadTarget(id);
      const decision = authorizationService.canManageUser({ id: actor.id, role: actor.role }, { id, role: target.role });
      if (!decision.ok) return deny(actor, 'user.status.change', id, decision.reason!);
      if (target.status === status) return toManaged(target);
      const updated = await userDao.setStatus(id, status);
      const revoked = status === 'disabled' ? await revokeAllSessions(id, 'account_disabled') : 0;
      await redisService.dropUserAuth(id);
      await auditLogService.record({ action: 'user.status.change', outcome: 'success', actor: { id: actor.id, role: actor.role }, target: { type: 'user', id }, metadata: { from: target.status, to: status, reason, sessionsRevoked: revoked } });
      return toManaged(updated!);
    }),

  revokeSessions: (actor: AuthUser, id: string) =>
    traced('UserManagementService.revokeSessions', async (): Promise<{ revoked: number }> => {
      const target = await loadTarget(id);
      const decision = authorizationService.canManageUser({ id: actor.id, role: actor.role }, { id, role: target.role });
      if (!decision.ok) return deny(actor, 'user.sessions.revoke', id, decision.reason!);
      const revoked = await revokeAllSessions(id, 'admin_revoked');
      await auditLogService.record({ action: 'user.sessions.revoke', outcome: 'success', actor: { id: actor.id, role: actor.role }, target: { type: 'user', id }, metadata: { revoked } });
      return { revoked };
    }),

  /** Session list with decrypted client info (IP / user agent) — admin only. */
  sessions: (actor: AuthUser, id: string) =>
    traced('UserManagementService.sessions', async () => {
      const target = await loadTarget(id);
      if (actor.id !== id && !authorizationService.canManageUser({ id: actor.id, role: actor.role }, { id, role: target.role }).ok) {
        throw new AppError(403, ERROR_CODES.FORBIDDEN, 'You can only view sessions of users ranked below you.');
      }
      const rows = await refreshSessionDao.listForUser(id);
      return rows.map((s) => ({
        sid: `${s.sid.slice(0, 8)}…`,
        createdAt: s.createdAt.getTime(),
        lastRotatedAt: s.lastRotatedAt.getTime(),
        expiresAt: s.expiresAt.getTime(),
        revokedAt: s.revokedAt?.getTime() ?? null,
        revokeReason: s.revokeReason,
        rotations: s.rotations,
        client: encryptionService.decryptJson<{ ip: string | null; userAgent: string | null }>(s.clientInfoEnc),
      }));
    }),
};
