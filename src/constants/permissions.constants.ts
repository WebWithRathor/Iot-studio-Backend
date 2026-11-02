import { ROLES, type Role } from './roles.constants';

/**
 * Explicit permissions. Every protected route declares the permission it
 * needs; roles map to permission sets below. Permissions are listed per role
 * on purpose (not derived from rank) so a reviewer can see exactly what each
 * role can do.
 */
export const PERMISSIONS = {
  // own account
  PROFILE_READ: 'profile:read',
  PROFILE_UPDATE: 'profile:update',
  // own workspace
  PROJECT_READ: 'project:read',
  PROJECT_WRITE: 'project:write',
  DASHBOARD_WRITE: 'dashboard:write',
  VARIABLE_WRITE: 'variable:write',
  DEVICE_READ: 'device:read',
  DEVICE_WRITE: 'device:write',
  DEVICE_SIMULATED_CREATE: 'device:simulated:create',
  TELEMETRY_READ: 'telemetry:read',
  COMMAND_PUBLISH: 'mqtt:command:publish',
  MQTT_RAW_PUBLISH: 'mqtt:raw:publish',
  ACTIVITY_READ: 'activity:read',
  DEMO_RESET: 'workspace:demo:reset',
  // administration
  ADMIN_OVERVIEW: 'admin:overview',
  USERS_READ: 'users:read',
  USERS_MANAGE: 'users:manage',
  USERS_ROLE_CHANGE: 'users:role:change',
  PROJECTS_MANAGE: 'projects:manage',
  DASHBOARDS_MANAGE: 'dashboards:manage',
  DEVICES_MANAGE: 'devices:manage',
  MQTT_MANAGE: 'mqtt:manage',
  AUDIT_READ: 'audit:read',
  /** Change plans / grant tokens / generate kit codes. */
  PLANS_MANAGE: 'plans:manage',
  SUPER_ADMIN_OPS: 'superadmin:ops',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const P = PERMISSIONS;

const USER_PERMISSIONS: Permission[] = [
  P.PROFILE_READ, P.PROFILE_UPDATE, P.PROJECT_READ, P.PROJECT_WRITE, P.DASHBOARD_WRITE, P.VARIABLE_WRITE,
  P.DEVICE_READ, P.DEVICE_WRITE, P.DEVICE_SIMULATED_CREATE, P.TELEMETRY_READ, P.COMMAND_PUBLISH, P.ACTIVITY_READ, P.DEMO_RESET,
];

/** Developers can additionally publish free-form test messages from the console (still only to their own devices). */
const DEVELOPER_PERMISSIONS: Permission[] = [...USER_PERMISSIONS, P.MQTT_RAW_PUBLISH];

const ADMIN_PERMISSIONS: Permission[] = [
  ...DEVELOPER_PERMISSIONS,
  P.ADMIN_OVERVIEW, P.USERS_READ, P.USERS_MANAGE, P.USERS_ROLE_CHANGE, P.PROJECTS_MANAGE, P.DASHBOARDS_MANAGE,
  P.DEVICES_MANAGE, P.MQTT_MANAGE, P.AUDIT_READ, P.PLANS_MANAGE,
];

const SUPER_ADMIN_PERMISSIONS: Permission[] = [...ADMIN_PERMISSIONS, P.SUPER_ADMIN_OPS];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = Object.freeze({
  [ROLES.USER]: new Set(USER_PERMISSIONS),
  [ROLES.DEVELOPER]: new Set(DEVELOPER_PERMISSIONS),
  [ROLES.ADMIN]: new Set(ADMIN_PERMISSIONS),
  [ROLES.SUPER_ADMIN]: new Set(SUPER_ADMIN_PERMISSIONS),
});
