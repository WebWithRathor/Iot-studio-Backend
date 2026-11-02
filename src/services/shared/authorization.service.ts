import { ROLE_PERMISSIONS, type Permission } from '../../constants/permissions.constants';
import { ROLE_RANK } from '../../constants/role-hierarchy.constants';
import { ROLES, type Role } from '../../constants/roles.constants';
import { notFound } from '../../utils/error.util';

const sameId = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b);

/**
 * The single source of authorisation decisions. Pure functions — no I/O —
 * so middleware and services share exactly the same rules and they are
 * unit-tested directly.
 */
export const authorizationService = {
  rank: (role: Role): number => ROLE_RANK[role] ?? 0,

  hasRoleAtLeast: (role: Role, min: Role): boolean => (ROLE_RANK[role] ?? 0) >= ROLE_RANK[min],

  hasPermission: (role: Role, permission: Permission): boolean => ROLE_PERMISSIONS[role]?.has(permission) ?? false,

  hasAllPermissions: (role: Role, permissions: Permission[]): boolean => permissions.every((p) => authorizationService.hasPermission(role, p)),

  permissionsOf: (role: Role): Permission[] => Array.from(ROLE_PERMISSIONS[role] ?? []),

  /**
   * May `actor` manage (disable, revoke sessions of) `target`?
   * Rules: never yourself; only users ranked strictly below you; a SUPER_ADMIN
   * can be managed only by another SUPER_ADMIN.
   */
  canManageUser(actor: { id: string; role: Role }, target: { id: string; role: Role }): { ok: boolean; reason?: string } {
    if (actor.id === target.id) return { ok: false, reason: 'You cannot change your own account from the admin area.' };
    if (target.role === ROLES.SUPER_ADMIN && actor.role !== ROLES.SUPER_ADMIN) return { ok: false, reason: 'Only a super admin can manage another super admin.' };
    if (actor.role !== ROLES.SUPER_ADMIN && ROLE_RANK[target.role] >= ROLE_RANK[actor.role]) return { ok: false, reason: 'You can only manage users ranked below you.' };
    return { ok: true };
  },

  /**
   * May `actor` give `target` the role `newRole`?
   * Adds: you can only grant roles strictly below your own, except a
   * SUPER_ADMIN, who may grant any role including SUPER_ADMIN.
   */
  canAssignRole(actor: { id: string; role: Role }, target: { id: string; role: Role }, newRole: Role): { ok: boolean; reason?: string } {
    const manage = authorizationService.canManageUser(actor, target);
    if (!manage.ok) return manage;
    if (actor.role === ROLES.SUPER_ADMIN) return { ok: true };
    if (ROLE_RANK[newRole] >= ROLE_RANK[actor.role]) return { ok: false, reason: 'You can only grant roles below your own.' };
    return { ok: true };
  },

  /**
   * Ownership guard for public (user-area) operations. A missing record and
   * someone else's record produce the SAME 404, so ids cannot be probed.
   * Role rank deliberately plays no part here.
   */
  assertOwned<T extends { ownerId: unknown }>(record: T | null | undefined, userId: string, what: string): T {
    if (!record || !sameId(record.ownerId, userId)) throw notFound(what);
    return record;
  },
};
