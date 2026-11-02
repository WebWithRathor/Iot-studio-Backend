import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { API, CSRF, getApp, PASSWORD, registeredAgent, request, shutdown, unavailableReason, uniqueEmail } from './helpers';

const cookie = (res: { headers: Record<string, unknown> }, name: string) =>
  ((res.headers['set-cookie'] as string[] | undefined) ?? []).find((c) => c.startsWith(`${name}=`)) ?? '';

after(shutdown);

describe('authentication', () => {
  it('register sets HttpOnly access (10 min) and refresh (7 d) cookies and never returns tokens in the body', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const res = await request(app).post(`${API}/auth/register`).set(CSRF).send({ name: 'Cookie Check', email: uniqueEmail(), password: PASSWORD });
    assert.equal(res.status, 201);
    const access = cookie(res, 'access_token');
    const refresh = cookie(res, 'refresh_token');
    assert.match(access, /HttpOnly/i);
    assert.match(access, /Max-Age=600/);
    assert.match(access, /Path=\/api\/v1;/);
    assert.match(access, /SameSite=Lax/i);
    assert.match(refresh, /HttpOnly/i);
    assert.match(refresh, /Max-Age=604800/);
    assert.match(refresh, /Path=\/api\/v1\/auth/);
    assert.doesNotMatch(JSON.stringify(res.body), /eyJ/);
    assert.equal(res.body.data.user.role, 'USER');
  });

  it('rejects a client-supplied role at registration', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const res = await request(app).post(`${API}/auth/register`).set(CSRF).send({ name: 'Sneaky', email: uniqueEmail(), password: PASSWORD, role: 'SUPER_ADMIN' });
    assert.equal(res.status, 400);
  });

  it('login succeeds with the right password and fails generically otherwise', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const { email } = await registeredAgent(app);
    assert.equal((await request(app).post(`${API}/auth/login`).set(CSRF).send({ email, password: PASSWORD })).status, 200);
    const bad = await request(app).post(`${API}/auth/login`).set(CSRF).send({ email, password: 'wrong-password-1' });
    const unknown = await request(app).post(`${API}/auth/login`).set(CSRF).send({ email: uniqueEmail(), password: 'wrong-password-1' });
    assert.equal(bad.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(bad.body.error.message, unknown.body.error.message, 'same message for unknown email and wrong password');
  });

  it('protected routes require a session', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const res = await request(app).get(`${API}/projects`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHENTICATED');
    assert.ok(res.body.requestId);
  });

  it('refresh rotates the token; replaying the old one revokes the session', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const login = await request(app).post(`${API}/auth/register`).set(CSRF).send({ name: 'Rotate', email: uniqueEmail(), password: PASSWORD });
    const oldRefresh = cookie(login, 'refresh_token').split(';')[0];
    const first = await request(app).post(`${API}/auth/refresh`).set(CSRF).set('Cookie', oldRefresh).send({});
    assert.equal(first.status, 200);
    const newRefresh = cookie(first, 'refresh_token').split(';')[0];
    assert.ok(newRefresh && newRefresh !== oldRefresh, 'a new refresh token is issued');
    await new Promise((r) => setTimeout(r, 10_500)); // past the 10 s parallel-tab grace window
    const replay = await request(app).post(`${API}/auth/refresh`).set(CSRF).set('Cookie', oldRefresh).send({});
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'SESSION_REVOKED');
    const afterTheft = await request(app).post(`${API}/auth/refresh`).set(CSRF).set('Cookie', newRefresh).send({});
    assert.equal(afterTheft.status, 401, 'the whole session is revoked after reuse');
  });

  it('logout revokes the session immediately (old access token stops working)', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const login = await request(app).post(`${API}/auth/register`).set(CSRF).send({ name: 'Bye', email: uniqueEmail(), password: PASSWORD });
    const access = cookie(login, 'access_token').split(';')[0];
    assert.equal((await request(app).get(`${API}/auth/me`).set('Cookie', access)).status, 200);
    const out = await request(app).post(`${API}/auth/logout`).set(CSRF).set('Cookie', access).send({});
    assert.equal(out.status, 200);
    assert.match(cookie(out, 'access_token'), /Expires=Thu, 01 Jan 1970/);
    assert.equal((await request(app).get(`${API}/auth/me`).set('Cookie', access)).status, 401);
  });
});
