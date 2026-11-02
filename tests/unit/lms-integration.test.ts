import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import { EnvValidationError, parseEnv } from '../../src/config/env.config';
import { parseBrokerUrl } from '../../src/config/lms.config';
import { ERROR_CODES } from '../../src/constants/error-codes.constants';
import { AppError } from '../../src/utils/error.util';
import { LmsApiError, toLmsApiError } from '../../src/utils/lms-api-error.util';
import { bodyHash, checkLmsSignature, signLmsRequest } from '../../src/utils/lms-signature.util';
import { LmsSsoError, sanitizeNextRoute, verifyLmsSsoToken } from '../../src/utils/lms-sso.util';
import { parseAck } from '../../src/utils/mqtt-topic.util';
import { lmsHardwareId, lmsUpsertDeviceBody } from '../../src/validations/integrations/lms.validation';

const SSO_SECRET = 's'.repeat(64);
const NOW = 1_800_000_000;
const ssoOpts = { secret: SSO_SECRET, issuer: 'kokoon-lms', audience: 'kokoon-iot-studio', clockSkewSec: 30, maxLifetimeSec: 120, now: NOW };

function mint(over: Record<string, unknown> = {}, opts: jwt.SignOptions = {}, secret = SSO_SECRET) {
  const payload = { sub: 'u_123', email: 'Student@Example.com', email_verified: true, name: 'A Student', jti: randomUUID(), iat: NOW, exp: NOW + 60, ...over };
  return jwt.sign(payload, secret, { algorithm: 'HS256', issuer: 'kokoon-lms', audience: 'kokoon-iot-studio', ...opts });
}

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof LmsSsoError && e.code === code);

describe('LMS SSO token verification', () => {
  it('accepts a valid token and normalises the email', () => {
    const c = verifyLmsSsoToken(mint(), ssoOpts);
    assert.equal(c.sub, 'u_123');
    assert.equal(c.email, 'student@example.com');
    assert.equal(c.emailVerified, true);
  });

  it('treats a missing email_verified as unverified', () => {
    assert.equal(verifyLmsSsoToken(mint({ email_verified: undefined }), ssoOpts).emailVerified, false);
  });

  it('rejects the wrong secret, issuer, audience and algorithm', () => {
    rejects(() => verifyLmsSsoToken(mint({}, {}, 'x'.repeat(64)), ssoOpts), 'invalid');
    rejects(() => verifyLmsSsoToken(mint({}, { issuer: 'someone-else' }), ssoOpts), 'invalid');
    rejects(() => verifyLmsSsoToken(mint({}, { audience: 'other-app' }), ssoOpts), 'invalid');
    rejects(() => verifyLmsSsoToken(mint({}, { algorithm: 'HS512' }), ssoOpts), 'invalid');
    const unsigned = jwt.sign({ sub: 'u', email: 'a@b.co', name: 'n', jti: randomUUID(), iat: NOW, exp: NOW + 60 }, '', { algorithm: 'none' } as jwt.SignOptions);
    rejects(() => verifyLmsSsoToken(unsigned, ssoOpts), 'invalid');
  });

  it('reports an expired token as expired, honouring the clock skew', () => {
    rejects(() => verifyLmsSsoToken(mint({ iat: NOW - 120, exp: NOW - 31 }), ssoOpts), 'expired');
    assert.ok(verifyLmsSsoToken(mint({ iat: NOW - 100, exp: NOW - 10 }), ssoOpts));
  });

  it('rejects tokens that live longer than 120 s or are issued in the future', () => {
    rejects(() => verifyLmsSsoToken(mint({ exp: NOW + 600 }), ssoOpts), 'invalid');
    rejects(() => verifyLmsSsoToken(mint({ iat: NOW + 90, exp: NOW + 120 }), ssoOpts), 'invalid');
  });

  it('rejects bad claims', () => {
    rejects(() => verifyLmsSsoToken(mint({ jti: 'not-a-uuid' }), ssoOpts), 'invalid');
    rejects(() => verifyLmsSsoToken(mint({ email: 'nope' }), ssoOpts), 'invalid');
    rejects(() => verifyLmsSsoToken(mint({ name: '' }), ssoOpts), 'invalid');
    rejects(() => verifyLmsSsoToken('short', ssoOpts), 'invalid');
  });

  it('is unavailable without a configured secret', () => {
    rejects(() => verifyLmsSsoToken(mint(), { ...ssoOpts, secret: '' }), 'unavailable');
  });
});

describe('SSO next route', () => {
  it('keeps known app routes', () => {
    for (const r of ['/', '/devices', '/devices/abc123', '/projects/p1', '/projects/p1/editor', '/projects/p1/editor/d2', '/projects/p1/variables', '/plan', '/payments', '/console']) {
      assert.equal(sanitizeNextRoute(r), r);
    }
  });

  it('falls back to / for anything that could leave the app', () => {
    for (const r of ['https://evil.example', '//evil.example', '/devices?x=1', '/admin', 'devices', '/devices/../admin', '/projects/p1/editor/a/b', 42, undefined, `/${'a'.repeat(300)}`]) {
      assert.equal(sanitizeNextRoute(r), '/', String(r));
    }
  });
});

describe('LMS request signing', () => {
  const secret = 'k'.repeat(64);
  const path = '/api/v1/integrations/lms/devices/kk-esp32s3-7f3k9q2m?rotateCredentials=true';
  const body = Buffer.from('{"a":1}');
  const ts = String(NOW);
  const base = { secret, timestamp: ts, requestId: randomUUID(), method: 'PUT', pathWithQuery: path, rawBody: body, maxSkewSec: 300, nowSec: NOW };

  it('matches an independently computed HMAC over ts.METHOD.path.body', () => {
    const expected = `sha256=${createHmac('sha256', secret).update(`${ts}.PUT.${path}.{"a":1}`).digest('hex')}`;
    assert.equal(signLmsRequest(secret, ts, 'put', path, body), expected);
  });

  it('accepts a correct signature (any hex case)', () => {
    const sig = signLmsRequest(secret, ts, 'PUT', path, body);
    assert.equal(checkLmsSignature({ ...base, signature: sig }), null);
    assert.equal(checkLmsSignature({ ...base, signature: `sha256=${sig.slice(7).toUpperCase()}` }), null);
  });

  it('rejects tampering with the body, path, method or secret', () => {
    const sig = signLmsRequest(secret, ts, 'PUT', path, body);
    assert.equal(checkLmsSignature({ ...base, signature: sig, rawBody: Buffer.from('{"a":2}') }), 'invalid_signature');
    assert.equal(checkLmsSignature({ ...base, signature: sig, pathWithQuery: path.replace('true', 'false') }), 'invalid_signature');
    assert.equal(checkLmsSignature({ ...base, signature: sig, method: 'DELETE' }), 'invalid_signature');
    assert.equal(checkLmsSignature({ ...base, signature: sig, secret: 'z'.repeat(64) }), 'invalid_signature');
    assert.equal(checkLmsSignature({ ...base, signature: 'sha256=abc' }), 'invalid_signature');
  });

  it('rejects stale or malformed timestamps', () => {
    const at = (t: number) => ({ ...base, timestamp: String(t), signature: signLmsRequest(secret, String(t), 'PUT', path, body) });
    assert.equal(checkLmsSignature(at(NOW - 300)), null);
    assert.equal(checkLmsSignature(at(NOW - 301)), 'stale_timestamp');
    assert.equal(checkLmsSignature(at(NOW + 301)), 'stale_timestamp');
    assert.equal(checkLmsSignature({ ...base, timestamp: '17e8', signature: 'sha256=00' }), 'stale_timestamp');
  });

  it('requires all headers and a UUID request id', () => {
    const sig = signLmsRequest(secret, ts, 'PUT', path, body);
    assert.equal(checkLmsSignature({ ...base, signature: undefined }), 'missing_headers');
    assert.equal(checkLmsSignature({ ...base, signature: sig, requestId: undefined }), 'missing_headers');
    assert.equal(checkLmsSignature({ ...base, signature: sig, requestId: 'abc' }), 'bad_request_id');
    assert.equal(checkLmsSignature({ ...base, signature: sig, secret: '' }), 'missing_headers');
  });

  it('body hash distinguishes bodies and paths but not timestamps', () => {
    assert.equal(bodyHash('PUT', path, body), bodyHash('PUT', path, Buffer.from('{"a":1}')));
    assert.notEqual(bodyHash('PUT', path, body), bodyHash('PUT', path, Buffer.from('{"a":2}')));
    assert.notEqual(bodyHash('PUT', path, body), bodyHash('PUT', '/other', body));
  });
});

describe('device ack parsing', () => {
  it('treats anything but {"ok":false} as acknowledged', () => {
    for (const p of ['', 'ok', '1', '{"ok":true}', '{"value":3}', '[false]', 'null', '{"ok":"false"}']) assert.deepEqual(parseAck(p), { ok: true }, p);
  });

  it('reports a device rejection with a cleaned message', () => {
    assert.deepEqual(parseAck('{"ok":false,"error":"Out of range"}'), { ok: false, error: 'Out of range' });
    assert.deepEqual(parseAck('{"ok":false}'), { ok: false, error: 'The device rejected the command.' });
    const r = parseAck(JSON.stringify({ ok: false, error: `bad\u0000\nvalue${'x'.repeat(300)}` }));
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.length <= 120 && !/[\u0000-\u001F]/.test(r.error)); // eslint-disable-line no-control-regex
  });
});

describe('LMS device upsert validation', () => {
  const body = () => ({
    user: { lmsUserId: 'u_1', email: 'a@b.co', emailVerified: true, name: 'A' },
    device: { name: 'Desk', board: 'ESP32-S3 DevKitC' },
    program: { programId: 'prog_1', name: 'Room monitor' },
    variables: [{ key: 'soil_moisture_raw', displayName: 'Soil', dataType: 'integer', direction: 'telemetry', min: 0, max: 4095, blockId: 'b1' }],
    project: { create: true },
  });

  it('accepts custom variable keys beyond the presets', () => {
    const r = lmsUpsertDeviceBody.safeParse(body());
    assert.ok(r.success, JSON.stringify(!r.success && r.error.issues));
  });

  it('defaults variables to [] and project.create to false', () => {
    const { variables: _v, project: _p, ...rest } = body();
    const r = lmsUpsertDeviceBody.parse(rest);
    assert.deepEqual(r.variables, []);
    assert.equal(r.project.create, false);
  });

  it('rejects duplicate keys, min > max, unknown fields and too many variables', () => {
    const dup = body();
    dup.variables.push({ ...dup.variables[0]!, blockId: 'b2' });
    assert.equal(lmsUpsertDeviceBody.safeParse(dup).success, false);
    const range = body();
    range.variables[0]!.min = 10;
    range.variables[0]!.max = 1;
    assert.equal(lmsUpsertDeviceBody.safeParse(range).success, false);
    assert.equal(lmsUpsertDeviceBody.safeParse({ ...body(), role: 'SUPER_ADMIN' }).success, false);
    const many = body();
    many.variables = Array.from({ length: 31 }, (_, i) => ({ ...many.variables[0]!, key: `v${i}`, blockId: `b${i}` }));
    assert.equal(lmsUpsertDeviceBody.safeParse(many).success, false);
    const badKey = body();
    badKey.variables[0]!.key = 'Bad-Key';
    assert.equal(lmsUpsertDeviceBody.safeParse(badKey).success, false);
  });

  it('rejects malformed and reserved hardware ids', () => {
    assert.ok(lmsHardwareId.safeParse('kk-esp32s3-7f3k9q2m').success);
    for (const h of ['KK-UPPER', 'ab', '-start', 'sandbox-abc', 'esp32-sim-1', 'has space', 'a'.repeat(49)]) assert.equal(lmsHardwareId.safeParse(h).success, false, h);
  });
});

describe('LMS environment rules', () => {
  const secret = (c: string) => c.repeat(64);
  const valid = {
    MONGODB_URI: 'mongodb://127.0.0.1:27017/kokoon',
    REDIS_URL: 'redis://127.0.0.1:6379/0',
    JWT_ACCESS_SECRET: secret('a'),
    JWT_REFRESH_SECRET: secret('b'),
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  };
  const lms = {
    LMS_INTEGRATION_ENABLED: 'true',
    LMS_URL: 'http://localhost:3000',
    LMS_SSO_SECRET: secret('c'),
    LMS_API_SECRET: secret('d'),
    MQTT_PUBLIC_BROKER_URL: 'mqtt://192.168.1.20:1883',
    MQTT_DEVICE_USERNAME: 'esp32-device',
    MQTT_DEVICE_PASSWORD: 'device-pass',
  };
  const fails = (env: Record<string, string>, re: RegExp) =>
    assert.throws(() => parseEnv(env), (e: unknown) => e instanceof EnvValidationError && re.test(e.message));

  it('is off by default and needs nothing extra', () => {
    const e = parseEnv(valid);
    assert.equal(e.LMS_INTEGRATION_ENABLED, false);
    assert.equal(e.BROKER_CREDENTIALS_MODE, 'shared');
  });

  it('accepts a complete development setup', () => {
    assert.equal(parseEnv({ ...valid, ...lms }).LMS_INTEGRATION_ENABLED, true);
  });

  it('requires the URL, both secrets, the public broker and shared device credentials when enabled', () => {
    for (const k of ['LMS_URL', 'LMS_SSO_SECRET', 'LMS_API_SECRET', 'MQTT_PUBLIC_BROKER_URL', 'MQTT_DEVICE_USERNAME']) {
      const env: Record<string, string> = { ...valid, ...lms };
      delete env[k];
      fails(env, new RegExp(k));
    }
  });

  it('rejects reused or short secrets', () => {
    fails({ ...valid, ...lms, LMS_API_SECRET: lms.LMS_SSO_SECRET }, /LMS_API_SECRET/);
    fails({ ...valid, ...lms, LMS_SSO_SECRET: valid.JWT_ACCESS_SECRET }, /LMS_SSO_SECRET/);
    fails({ ...valid, ...lms, LMS_SSO_SECRET: 'short' }, /LMS_SSO_SECRET/);
  });

  it('requires MQTT_MODE=broker for mosquitto-dynsec', () => {
    fails({ ...valid, ...lms, BROKER_CREDENTIALS_MODE: 'mosquitto-dynsec' }, /BROKER_CREDENTIALS_MODE/);
  });
});

describe('public broker URL', () => {
  it('parses host, port and TLS with protocol defaults', () => {
    assert.deepEqual(parseBrokerUrl('mqtt://192.168.1.20:1883'), { url: 'mqtt://192.168.1.20:1883', host: '192.168.1.20', port: 1883, tls: false });
    assert.equal(parseBrokerUrl('mqtts://broker.kokoon.io').port, 8883);
    assert.equal(parseBrokerUrl('mqtts://broker.kokoon.io').tls, true);
    assert.equal(parseBrokerUrl('wss://broker.kokoon.io/mqtt').port, 443);
    assert.equal(parseBrokerUrl('ws://localhost').port, 80);
  });
});

describe('LMS API error mapping', () => {
  it('passes LmsApiError through and maps app errors to contract codes', () => {
    const own = new LmsApiError(409, 'device_owned_by_other_user', 'x');
    assert.equal(toLmsApiError(own), own);
    const map = (code: string, status = 400) => toLmsApiError(new AppError(status, code as never, 'msg'));
    assert.equal(map(ERROR_CODES.VALIDATION_ERROR).code, 'validation_failed');
    assert.equal(map(ERROR_CODES.VALIDATION_ERROR).status, 422);
    assert.equal(map(ERROR_CODES.NOT_FOUND, 404).status, 404);
    assert.equal(map(ERROR_CODES.RATE_LIMITED, 429).code, 'rate_limited');
    assert.equal(map(ERROR_CODES.DATABASE_UNAVAILABLE, 503).code, 'unavailable');
  });

  it('never exposes internal error messages', () => {
    const e = toLmsApiError(new Error('mongo connection string mongodb://user:pw@host'));
    assert.equal(e.status, 500);
    assert.doesNotMatch(e.message, /mongodb/);
  });
});
