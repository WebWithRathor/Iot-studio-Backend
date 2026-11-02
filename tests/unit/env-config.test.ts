import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EnvValidationError, parseEnv } from '../../src/config/env.config';

const secret = (c: string) => c.repeat(64);
const valid = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/kokoon',
  REDIS_URL: 'redis://127.0.0.1:6379/0',
  JWT_ACCESS_SECRET: secret('a'),
  JWT_REFRESH_SECRET: secret('b'),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('environment validation', () => {
  it('accepts a minimal development configuration with safe defaults', () => {
    const e = parseEnv(valid);
    assert.equal(e.NODE_ENV, 'development');
    assert.equal(e.ACCESS_TOKEN_TTL, 600, 'access token defaults to 10 minutes');
    assert.equal(e.REFRESH_TOKEN_TTL, 7 * 86400, 'refresh token defaults to 7 days');
    assert.equal(e.MQTT_MODE, 'simulated');
  });

  it('lists every missing variable by name', () => {
    try {
      parseEnv({});
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof EnvValidationError);
      for (const k of ['MONGODB_URI', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'ENCRYPTION_KEY']) assert.match(err.message, new RegExp(k));
    }
  });

  it('never echoes secret values in errors', () => {
    const leaked = 'super-secret-but-too-short';
    try {
      parseEnv({ ...valid, JWT_ACCESS_SECRET: leaked });
      assert.fail('should throw');
    } catch (err) {
      assert.doesNotMatch((err as Error).message, new RegExp(leaked));
    }
  });

  it('rejects malformed URLs, enums and numbers', () => {
    assert.throws(() => parseEnv({ ...valid, MONGODB_URI: 'postgres://x' }), /MONGODB_URI/);
    assert.throws(() => parseEnv({ ...valid, MQTT_MODE: 'kafka' }), /MQTT_MODE/);
    assert.throws(() => parseEnv({ ...valid, PORT: 'eighty' }), /PORT/);
    assert.throws(() => parseEnv({ ...valid, ACCESS_TOKEN_TTL: '2y' }), /ACCESS_TOKEN_TTL/);
  });

  it('requires different access and refresh secrets', () => assert.throws(() => parseEnv({ ...valid, JWT_REFRESH_SECRET: valid.JWT_ACCESS_SECRET }), /JWT_REFRESH_SECRET/));

  it('requires a broker URL in broker mode', () => assert.throws(() => parseEnv({ ...valid, MQTT_MODE: 'broker', MQTT_BROKER_URL: undefined }), /MQTT_BROKER_URL/));

  it('rejects insecure production settings', () => {
    assert.throws(() => parseEnv({ ...valid, NODE_ENV: 'production', FRONTEND_URL: 'https://studio.kokoon.example' }), /COOKIE_SECURE/);
    assert.throws(
      () => parseEnv({ ...valid, NODE_ENV: 'production', COOKIE_SECURE: 'true', FRONTEND_URL: 'https://x.example', DEMO_WORKSPACE_ON_SIGNUP: 'false', ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') }),
      /ENCRYPTION_KEY/,
    );
    assert.throws(() => parseEnv({ ...valid, NODE_ENV: 'production', COOKIE_SECURE: 'true', FRONTEND_URL: 'http://x.example', DEMO_WORKSPACE_ON_SIGNUP: 'false' }), /FRONTEND_URL/);
  });

  it('SameSite=None requires Secure cookies', () => assert.throws(() => parseEnv({ ...valid, COOKIE_SAME_SITE: 'none' }), /COOKIE_SAME_SITE/));
});
