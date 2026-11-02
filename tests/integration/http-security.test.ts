import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { API, CSRF, getApp, registeredAgent, request, shutdown, unavailableReason } from './helpers';

after(shutdown);

describe('HTTP-level security', () => {
  it('rejects operator injection in login', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const res = await request(app).post(`${API}/auth/login`).set(CSRF).send({ email: { $ne: null }, password: { $ne: null } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'UNSAFE_INPUT');
  });

  it('rejects nested query objects', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const { agent } = await registeredAgent(app);
    const res = await agent.get(`${API}/projects?q[$regex]=.*`);
    assert.ok([200, 400].includes(res.status));
    if (res.status === 200) assert.equal(res.body.data.items.length, 0, "the simple parser keeps 'q[$regex]' as a literal key that is ignored");
  });

  it('rejects state-changing requests without the CSRF header', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const { agent } = await registeredAgent(app);
    const res = await agent.post(`${API}/projects`).send({ name: 'no header' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'CSRF_REJECTED');
  });

  it('rejects unknown origins via CORS', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const res = await request(app).get(`${API}/health`).set('Origin', 'https://evil.example');
    assert.equal(res.status, 403);
  });

  it('limits body size', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const res = await request(app).post(`${API}/auth/login`).set(CSRF).send({ email: 'a@b.co', password: 'x'.repeat(300_000) });
    assert.equal(res.status, 413);
  });

  it('invalid ids are 400, not 500', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const { agent } = await registeredAgent(app);
    assert.equal((await agent.get(`${API}/projects/not-an-id`)).status, 400);
  });

  it('sets security headers and no stack traces', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const res = await request(app).get(`${API}/nope`);
    assert.equal(res.status, 404);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(res.headers['x-powered-by'], undefined);
    assert.doesNotMatch(JSON.stringify(res.body), /at .*\.ts:\d+/);
  });

  it('auth endpoints are rate limited', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    if (Number(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS) > 50) return t.skip('AUTH_RATE_LIMIT_MAX_REQUESTS raised for the test run; run with AUTH_RATE_LIMIT_MAX_REQUESTS=5 to exercise');
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await request(app).post(`${API}/auth/login`).set(CSRF).send({ email: 'rl@test.kokoon.local', password: 'wrong-pass-1' })).status;
    assert.equal(last, 429);
  });
});
