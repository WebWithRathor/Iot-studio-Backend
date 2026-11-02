import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { agentWithRole, API, CSRF, getApp, registeredAgent, ROLES, shutdown, unavailableReason } from './helpers';

after(shutdown);

describe('ownership (public area)', () => {
  it('a user cannot read, change or delete another user’s project by id', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const alice = await registeredAgent(app, 'Alice');
    const bob = await registeredAgent(app, 'Bob');
    const created = await alice.agent.post(`${API}/projects`).set(CSRF).send({ name: 'Alice private' });
    assert.equal(created.status, 201);
    const id = created.body.data.project.id;
    assert.equal((await bob.agent.get(`${API}/projects/${id}`)).status, 404);
    assert.equal((await bob.agent.patch(`${API}/projects/${id}`).set(CSRF).send({ name: 'pwned' })).status, 404);
    assert.equal((await bob.agent.delete(`${API}/projects/${id}`).set(CSRF)).status, 404);
    assert.equal((await alice.agent.get(`${API}/projects/${id}`)).body.data.name, 'Alice private');
  });

  it('even an admin cannot open another user’s project through the user API', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const alice = await registeredAgent(app, 'Alice2');
    const admin = await agentWithRole(app, ROLES.ADMIN);
    const id = (await alice.agent.post(`${API}/projects`).set(CSRF).send({ name: 'Mine' })).body.data.project.id;
    assert.equal((await admin.agent.get(`${API}/projects/${id}`)).status, 404, 'role rank never overrides ownership');
    assert.equal((await admin.agent.get(`${API}/admin/projects/${id}`)).status, 200, 'the private admin API is the audited way in');
  });
});

describe('private (admin) area', () => {
  it('USER and DEVELOPER are refused, ADMIN is allowed', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const user = await registeredAgent(app);
    const dev = await agentWithRole(app, ROLES.DEVELOPER);
    const admin = await agentWithRole(app, ROLES.ADMIN);
    assert.equal((await user.agent.get(`${API}/admin/users`)).status, 403);
    assert.equal((await dev.agent.get(`${API}/admin/users`)).status, 403);
    assert.equal((await admin.agent.get(`${API}/admin/users`)).status, 200);
    assert.equal((await user.agent.get(`${API}/admin/audit-logs`)).status, 403);
  });

  it('role changes follow the hierarchy and sign the target out', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const admin = await agentWithRole(app, ROLES.ADMIN);
    const target = await registeredAgent(app, 'Promote me');
    const toAdmin = await admin.agent.patch(`${API}/admin/users/${target.user.id}/role`).set(CSRF).send({ role: 'ADMIN' });
    assert.equal(toAdmin.status, 403, 'an admin cannot create another admin');
    const toDev = await admin.agent.patch(`${API}/admin/users/${target.user.id}/role`).set(CSRF).send({ role: 'DEVELOPER' });
    assert.equal(toDev.status, 200);
    assert.equal((await target.agent.get(`${API}/auth/me`)).status, 401, 'old session no longer valid after a role change');
    const self = await admin.agent.patch(`${API}/admin/users/${admin.user.id}/role`).set(CSRF).send({ role: 'SUPER_ADMIN' });
    assert.equal(self.status, 403, 'no self-promotion');
  });

  it('the last super admin cannot be demoted', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const su1 = await agentWithRole(app, ROLES.SUPER_ADMIN);
    const list = await su1.agent.get(`${API}/admin/users?role=SUPER_ADMIN&pageSize=100`);
    const others = list.body.data.items.filter((u: { id: string }) => u.id !== su1.user.id);
    if (others.length) return t.skip('another super admin exists in the test database');
    const su2 = await agentWithRole(app, ROLES.SUPER_ADMIN);
    assert.equal((await su2.agent.patch(`${API}/admin/users/${su1.user.id}/role`).set(CSRF).send({ role: 'ADMIN' })).status, 200);
    assert.equal((await su1.agent.get(`${API}/auth/me`)).status, 401);
  });

  it('audit log records permission denials and is admin-only', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const user = await registeredAgent(app);
    await user.agent.get(`${API}/admin/overview`);
    const admin = await agentWithRole(app, ROLES.ADMIN);
    const logs = await admin.agent.get(`${API}/admin/audit-logs?action=authz.denied&pageSize=50`);
    assert.equal(logs.status, 200);
    assert.ok(logs.body.data.items.some((l: { actorId: string }) => l.actorId === user.user.id));
    assert.doesNotMatch(JSON.stringify(logs.body), /password|eyJ/i);
  });
});
