import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PERMISSIONS as P, ROLE_PERMISSIONS } from '../../src/constants/permissions.constants';
import { ROLE_RANK } from '../../src/constants/role-hierarchy.constants';
import { ALL_ROLES, DEFAULT_ROLE, ROLES } from '../../src/constants/roles.constants';
import { authorizationService as authz } from '../../src/services/shared/authorization.service';
import { AppError } from '../../src/utils/error.util';

const su = { id: 'a'.repeat(24), role: ROLES.SUPER_ADMIN };
const admin = { id: 'b'.repeat(24), role: ROLES.ADMIN };
const admin2 = { id: 'e'.repeat(24), role: ROLES.ADMIN };
const dev = { id: 'c'.repeat(24), role: ROLES.DEVELOPER };
const user = { id: 'd'.repeat(24), role: ROLES.USER };

describe('role hierarchy', () => {
  it('ranks SUPER_ADMIN > ADMIN > DEVELOPER > USER', () => {
    assert.ok(ROLE_RANK.SUPER_ADMIN > ROLE_RANK.ADMIN && ROLE_RANK.ADMIN > ROLE_RANK.DEVELOPER && ROLE_RANK.DEVELOPER > ROLE_RANK.USER);
    assert.equal(authz.hasRoleAtLeast(ROLES.ADMIN, ROLES.DEVELOPER), true);
    assert.equal(authz.hasRoleAtLeast(ROLES.USER, ROLES.ADMIN), false);
  });
  it('registers new accounts as USER', () => assert.equal(DEFAULT_ROLE, ROLES.USER));
  it('every role has a permission set', () => ALL_ROLES.forEach((r) => assert.ok(ROLE_PERMISSIONS[r].size > 0)));
});

describe('permissions', () => {
  it('USER can work in their own workspace but not administer', () => {
    for (const p of [P.PROJECT_WRITE, P.DASHBOARD_WRITE, P.COMMAND_PUBLISH, P.TELEMETRY_READ]) assert.ok(authz.hasPermission(ROLES.USER, p), p);
    for (const p of [P.USERS_READ, P.USERS_ROLE_CHANGE, P.DEVICES_MANAGE, P.AUDIT_READ, P.MQTT_MANAGE, P.MQTT_RAW_PUBLISH]) assert.equal(authz.hasPermission(ROLES.USER, p), false, p);
  });
  it('DEVELOPER adds raw console publish, still no admin permissions', () => {
    assert.ok(authz.hasPermission(ROLES.DEVELOPER, P.MQTT_RAW_PUBLISH));
    assert.equal(authz.hasPermission(ROLES.DEVELOPER, P.USERS_READ), false);
    assert.equal(authz.hasPermission(ROLES.DEVELOPER, P.ADMIN_OVERVIEW), false);
  });
  it('ADMIN administers but lacks super-admin operations', () => {
    assert.ok(authz.hasAllPermissions(ROLES.ADMIN, [P.USERS_MANAGE, P.DEVICES_MANAGE, P.AUDIT_READ]));
    assert.equal(authz.hasPermission(ROLES.ADMIN, P.SUPER_ADMIN_OPS), false);
  });
  it('higher roles are supersets of lower roles', () => {
    const order = [ROLES.USER, ROLES.DEVELOPER, ROLES.ADMIN, ROLES.SUPER_ADMIN];
    for (let i = 1; i < order.length; i++) for (const p of ROLE_PERMISSIONS[order[i - 1]]) assert.ok(ROLE_PERMISSIONS[order[i]].has(p), `${order[i]} missing ${p}`);
  });
});

describe('user management rules', () => {
  it('nobody manages themselves', () => assert.equal(authz.canManageUser(admin, admin).ok, false));
  it('admins manage only lower ranks', () => {
    assert.equal(authz.canManageUser(admin, user).ok, true);
    assert.equal(authz.canManageUser(admin, admin2).ok, false);
    assert.equal(authz.canManageUser(admin, su).ok, false);
  });
  it('only a super admin manages a super admin', () => assert.equal(authz.canManageUser({ ...su, id: 'f'.repeat(24) }, su).ok, true));
  it('admins can grant only roles below their own', () => {
    assert.equal(authz.canAssignRole(admin, user, ROLES.DEVELOPER).ok, true);
    assert.equal(authz.canAssignRole(admin, user, ROLES.ADMIN).ok, false);
    assert.equal(authz.canAssignRole(admin, dev, ROLES.SUPER_ADMIN).ok, false);
  });
  it('a super admin can grant any role', () => assert.equal(authz.canAssignRole(su, user, ROLES.SUPER_ADMIN).ok, true));
  it('developers cannot manage anyone ranked equal or above', () => assert.equal(authz.canManageUser(dev, admin).ok, false));
});

describe('ownership', () => {
  it('returns the record for its owner', () => assert.ok(authz.assertOwned({ ownerId: user.id }, user.id, 'Project')));
  it('404s (not 403) for someone else’s record — no existence leak, regardless of role', () => {
    assert.throws(() => authz.assertOwned({ ownerId: user.id }, su.id, 'Project'), (e: unknown) => e instanceof AppError && e.status === 404);
    assert.throws(() => authz.assertOwned(null, user.id, 'Project'), (e: unknown) => e instanceof AppError && e.status === 404);
  });
});
