/**
 * Central role identifiers. Never compare role strings anywhere else —
 * import from here.
 */
export const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  DEVELOPER: 'DEVELOPER',
  USER: 'USER',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES: readonly Role[] = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.DEVELOPER, ROLES.USER];

/** Role given to every self-registered account. Clients can never choose their role. */
export const DEFAULT_ROLE: Role = ROLES.USER;

export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ALL_ROLES as readonly string[]).includes(v);
