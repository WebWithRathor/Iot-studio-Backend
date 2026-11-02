import { ROLES, type Role } from './roles.constants';

/**
 *   SUPER_ADMIN (4)
 *        ▼
 *     ADMIN (3)
 *        ▼
 *   DEVELOPER (2)
 *        ▼
 *      USER (1)
 *
 * Rank is used for "at least" checks and for deciding who may manage whom.
 * Rank NEVER overrides resource ownership: public endpoints are always scoped
 * to the caller's own resources, whatever their role.
 */
export const ROLE_RANK: Readonly<Record<Role, number>> = Object.freeze({
  [ROLES.SUPER_ADMIN]: 4,
  [ROLES.ADMIN]: 3,
  [ROLES.DEVELOPER]: 2,
  [ROLES.USER]: 1,
});

/** Roles that may reach the private (/admin) API surface at all. */
export const PRIVATE_AREA_MIN_ROLE: Role = ROLES.ADMIN;
