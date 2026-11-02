import '../helpers/lms-test-env';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { userDao } from '../../src/dao/user.dao';
import { hashPassword } from '../../src/services/public/auth.service';
import { LMS_HEADERS, signLmsRequest } from '../../src/utils/lms-signature.util';
import { LMS_TEST } from '../helpers/lms-test-env';
import { API, getApp, PASSWORD, request, shutdown, unavailableReason, uniqueEmail } from './helpers';

after(shutdown);

const FRONTEND = 'http://localhost:5173';

function ssoToken(user: { sub: string; email: string; name?: string; verified?: boolean }) {
  return jwt.sign({ email: user.email, email_verified: user.verified ?? true, name: user.name ?? 'LMS Student', jti: randomUUID() }, LMS_TEST.ssoSecret, {
    algorithm: 'HS256', issuer: 'kokoon-lms', audience: 'kokoon-iot-studio', subject: user.sub, expiresIn: 60,
  });
}

const sso = (app: Express, token: string, next = '/devices', origin = LMS_TEST.url) =>
  request(app).post(`${API}/auth/lms/sso`).set('Origin', origin).type('form').send({ token, next });

/** A signed LMS → IoT Studio request. */
function lms(app: Express, method: 'PUT' | 'GET' | 'DELETE', hardwareId: string, body?: unknown, o: { requestId?: string; query?: string } = {}) {
  const path = `${API}/integrations/lms/devices/${hardwareId}${o.query ?? ''}`;
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const req = request(app)[method === 'PUT' ? 'put' : method === 'GET' ? 'get' : 'delete'](path)
    .set(LMS_HEADERS.TIMESTAMP, ts)
    .set(LMS_HEADERS.REQUEST_ID, o.requestId ?? randomUUID())
    .set(LMS_HEADERS.SIGNATURE, signLmsRequest(LMS_TEST.apiSecret, ts, method, path, raw));
  return raw ? req.set('Content-Type', 'application/json').send(raw) : req;
}

/** A signed POST to the bulk status endpoint. */
function lmsStatus(app: Express, body: unknown, requestId = randomUUID()) {
  const path = `${API}/integrations/lms/devices/status`;
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return request(app).post(path)
    .set(LMS_HEADERS.TIMESTAMP, ts)
    .set(LMS_HEADERS.REQUEST_ID, requestId)
    .set(LMS_HEADERS.SIGNATURE, signLmsRequest(LMS_TEST.apiSecret, ts, 'POST', path, raw))
    .set('Content-Type', 'application/json')
    .send(raw);
}

let hw = 0;
const hardwareId = () => `kk-test-${Date.now().toString(36)}-${hw++}`;
const upsertBody = (user: { sub: string; email: string; verified?: boolean }, programId = 'prog_room', create = true) => ({
  user: { lmsUserId: user.sub, email: user.email, emailVerified: user.verified ?? true, name: 'LMS Student' },
  device: { name: 'Desk ESP32', board: 'ESP32-S3 DevKitC', firmwareVersion: 'r1' },
  program: { programId, name: 'Room Monitor', version: 'r1' },
  variables: [
    { key: 'temperature', displayName: 'Temperature', dataType: 'float', direction: 'telemetry', unit: '°C', min: 0, max: 50, blockId: 'blk_temp' },
    { key: 'led_state', displayName: 'LED', dataType: 'boolean', direction: 'bidirectional', blockId: 'blk_led' },
  ],
  project: { create },
});

describe('Sign in with Kokoon LMS (contract A)', () => {
  it('creates an LMS user, sets session cookies and redirects to the requested route', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const res = await sso(app, ssoToken({ sub: `u_${randomUUID()}`, email: uniqueEmail('lms') }));
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, `${FRONTEND}/#/devices`);
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    assert.ok(cookies.some((c) => c.startsWith('access_token=')));
    const me = await request(app).get(`${API}/auth/me`).set('Cookie', cookies.map((c) => c.split(';')[0]).join('; '));
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.source, 'lms');
    assert.equal(me.body.data.user.passwordSet, false);
  });

  it('refuses a replayed token, a foreign origin and an open-redirect next', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const token = ssoToken({ sub: `u_${randomUUID()}`, email: uniqueEmail('lms') });
    assert.equal((await sso(app, token, '//evil.example')).headers.location, `${FRONTEND}/#/`);
    assert.equal((await sso(app, token)).headers.location, `${FRONTEND}/#/login?sso_error=replayed`);
    const other = await sso(app, ssoToken({ sub: `u_${randomUUID()}`, email: uniqueEmail('lms') }), '/', 'https://evil.example');
    assert.equal(other.headers.location, `${FRONTEND}/#/login?sso_error=invalid`);
  });

  it('links an existing account only when the LMS verified the email', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const email = uniqueEmail('local');
    const local = await userDao.create({ email, name: 'Local User', passwordHash: await hashPassword(PASSWORD), role: 'USER' });
    const sub = `u_${randomUUID()}`;
    const unverified = await sso(app, ssoToken({ sub, email, verified: false }));
    assert.equal(unverified.headers.location, `${FRONTEND}/#/login?sso_error=invalid`);
    assert.equal((await userDao.findById(String(local._id)))?.lmsUserId ?? null, null);
    const verified = await sso(app, ssoToken({ sub, email }));
    assert.equal(verified.headers.location, `${FRONTEND}/#/devices`);
    assert.equal((await userDao.findById(String(local._id)))?.lmsUserId, sub);
  });

  it('a password login is refused for an LMS-only account', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const email = uniqueEmail('lms');
    await sso(app, ssoToken({ sub: `u_${randomUUID()}`, email }));
    const res = await request(app).post(`${API}/auth/login`).set('X-Requested-With', 'XMLHttpRequest').send({ email, password: PASSWORD });
    assert.equal(res.status, 401);
  });
});

describe('LMS device API (contract B)', () => {
  it('rejects unsigned, tampered and stale requests', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const h = hardwareId();
    const unsigned = await request(app).get(`${API}/integrations/lms/devices/${h}`);
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.body.error.code, 'invalid_signature');
    const ts = String(Math.floor(Date.now() / 1000) - 3600);
    const path = `${API}/integrations/lms/devices/${h}`;
    const stale = await request(app).get(path).set(LMS_HEADERS.TIMESTAMP, ts).set(LMS_HEADERS.REQUEST_ID, randomUUID()).set(LMS_HEADERS.SIGNATURE, signLmsRequest(LMS_TEST.apiSecret, ts, 'GET', path, ''));
    assert.equal(stale.body.error.code, 'stale_timestamp');
  });

  it('B1 creates the device, credentials and a project; a re-flash updates without new credentials', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const user = { sub: `u_${randomUUID()}`, email: uniqueEmail('lms') };
    const h = hardwareId();
    const first = await lms(app, 'PUT', h, upsertBody(user));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.hardwareId, h);
    assert.equal(first.body.broker.host, '192.168.1.20');
    assert.equal(first.body.credentials.username, 'esp32-device');
    assert.ok(first.body.projectId);
    assert.deepEqual(first.body.warnings, []);
    assert.match(first.headers['cache-control'] ?? '', /no-store/);

    const body = upsertBody(user);
    body.variables = [body.variables[0]!];
    const second = await lms(app, 'PUT', h, body);
    assert.equal(second.status, 200);
    assert.equal(second.body.deviceId, first.body.deviceId);
    assert.equal(second.body.projectId, first.body.projectId);
    assert.equal(second.body.credentials, null);

    const rotated = await lms(app, 'PUT', h, body, { query: '?rotateCredentials=true' });
    assert.ok(rotated.body.credentials);

    const status = await lms(app, 'GET', h);
    assert.equal(status.status, 200);
    assert.equal(status.body.ownerLmsUserId, user.sub);
    assert.deepEqual(status.body.projectIds, [first.body.projectId]);
  });

  it('replays an idempotent retry and refuses a reused request id with another body', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const user = { sub: `u_${randomUUID()}`, email: uniqueEmail('lms') };
    const h = hardwareId();
    const requestId = randomUUID();
    const a = await lms(app, 'PUT', h, upsertBody(user, 'prog_a', false), { requestId });
    const b = await lms(app, 'PUT', h, upsertBody(user, 'prog_a', false), { requestId });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(b.headers['x-kokoon-idempotent-replay'], 'true');
    assert.deepEqual(b.body, a.body);
    const c = await lms(app, 'PUT', h, upsertBody(user, 'prog_b', false), { requestId });
    assert.equal(c.status, 422);
  });

  it('409 when the board belongs to another student', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const h = hardwareId();
    assert.equal((await lms(app, 'PUT', h, upsertBody({ sub: `u_${randomUUID()}`, email: uniqueEmail('lms') }, 'p', false))).status, 201);
    const res = await lms(app, 'PUT', h, upsertBody({ sub: `u_${randomUUID()}`, email: uniqueEmail('lms') }, 'p', false));
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'device_owned_by_other_user');
  });

  it('still registers the device when the student cannot afford another project', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const user = { sub: `u_${randomUUID()}`, email: uniqueEmail('lms') };
    assert.ok((await lms(app, 'PUT', hardwareId(), upsertBody(user, 'prog_one'))).body.projectId);
    const res = await lms(app, 'PUT', hardwareId(), upsertBody(user, 'prog_two'));
    assert.equal(res.status, 201);
    assert.equal(res.body.projectId, null);
    assert.deepEqual(res.body.warnings, ['insufficient_tokens_project_not_created']);
  });

  it('B3 disables the device idempotently; a later flash re-enables it with new credentials', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const user = { sub: `u_${randomUUID()}`, email: uniqueEmail('lms') };
    const h = hardwareId();
    await lms(app, 'PUT', h, upsertBody(user, 'p', false));
    assert.equal((await lms(app, 'DELETE', h)).status, 204);
    assert.equal((await lms(app, 'DELETE', h)).status, 204);
    assert.equal((await lms(app, 'GET', h)).body.connectionState, 'disabled');
    const again = await lms(app, 'PUT', h, upsertBody(user, 'p', false));
    assert.equal(again.status, 200);
    assert.ok(again.body.credentials);
    assert.equal((await lms(app, 'DELETE', hardwareId())).status, 404);
  });

  it('binds the chip: chip_mismatch on another chip, chip_in_use across boards, replaceChip moves it with new credentials', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const user = { sub: `u_${randomUUID()}`, email: uniqueEmail('lms') };
    const withChip = (u: typeof user, chipId: string) => {
      const b = upsertBody(u, 'p', false);
      return { ...b, device: { ...b.device, chipId } };
    };
    const [A, B] = [randomBytes(6).toString('hex'), randomBytes(6).toString('hex')];
    const h = hardwareId();
    const h2 = hardwareId();
    assert.equal((await lms(app, 'PUT', h, withChip(user, A))).status, 201);
    assert.equal((await lms(app, 'PUT', h, withChip(user, A))).body.credentials, null, 'same chip: plain re-flash');

    const mismatch = await lms(app, 'PUT', h, withChip(user, B));
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error.code, 'chip_mismatch');

    const inUse = await lms(app, 'PUT', h2, withChip(user, A));
    assert.equal(inUse.status, 409);
    assert.equal(inUse.body.error.code, 'chip_in_use');
    assert.deepEqual(inUse.body.error.details, { hardwareId: h });
    const foreign = await lms(app, 'PUT', hardwareId(), withChip({ sub: `u_${randomUUID()}`, email: uniqueEmail('lms') }, A));
    assert.equal(foreign.body.error.code, 'chip_in_use');
    assert.equal(foreign.body.error.details, undefined, 'another student never learns the hardware id');

    const replaced = await lms(app, 'PUT', h, withChip(user, B), { query: '?replaceChip=true' });
    assert.equal(replaced.status, 200);
    assert.ok(replaced.body.credentials);
    assert.equal((await lms(app, 'GET', h)).body.chipId, B);
    assert.equal((await lms(app, 'PUT', h2, withChip(user, A))).status, 201, 'chip A is free again');
  });

  it('refuses hardware ids reserved for the broker accounts', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const user = { sub: `u_${randomUUID()}`, email: uniqueEmail('lms') };
    for (const h of ['kokoon-backend', 'esp32-device', 'admin-board']) {
      const res = await lms(app, 'PUT', h, upsertBody(user, 'p', false));
      assert.equal(res.status, 422, h);
      assert.equal(res.body.error.code, 'validation_failed');
    }
  });

  it('bulk status answers known LMS boards, lists the rest as missing and is never replayed', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const user = { sub: `u_${randomUUID()}`, email: uniqueEmail('lms') };
    const h = hardwareId();
    const unknown = hardwareId();
    await lms(app, 'PUT', h, upsertBody(user, 'p', false));
    const requestId = randomUUID();
    const res = await lmsStatus(app, { hardwareIds: [h, unknown, h] }, requestId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.devices.length, 1);
    assert.equal(res.body.devices[0].hardwareId, h);
    assert.equal(res.body.devices[0].ownerLmsUserId, user.sub);
    assert.equal(typeof res.body.devices[0].connectionState, 'string');
    assert.deepEqual(res.body.missing, [unknown]);
    const again = await lmsStatus(app, { hardwareIds: [h] }, requestId);
    assert.equal(again.status, 200);
    assert.equal(again.headers['x-kokoon-idempotent-replay'], undefined);
    assert.equal((await lmsStatus(app, { hardwareIds: [] })).status, 422);
  });
});
