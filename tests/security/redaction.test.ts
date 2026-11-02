import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REDACTED, redact, redactString, summarisePayload } from '../../src/utils/redact.util';

describe('log redaction', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = redact({ user: { email: 'a@b.co', password: 'hunter2' }, headers: { cookie: 'access_token=abc', authorization: 'Bearer x' }, refreshToken: 'r', mqttPassword: 'p', apiKey: 'k' }) as Record<string, any>;
    assert.equal(out.user.password, REDACTED);
    assert.equal(out.headers.cookie, REDACTED);
    assert.equal(out.headers.authorization, REDACTED);
    assert.equal(out.refreshToken, REDACTED);
    assert.equal(out.mqttPassword, REDACTED);
    assert.equal(out.apiKey, REDACTED);
    assert.equal(out.user.email, 'a@b.co');
  });
  it('removes JWTs and URI credentials inside strings', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    assert.doesNotMatch(redactString(`token ${jwt} used`), /eyJhbGci/);
    assert.equal(redactString('mongodb://admin:s3cret@db:27017/x'), `mongodb://${REDACTED}@db:27017/x`);
  });
  it('truncates long values and payloads', () => {
    assert.ok(redactString('x'.repeat(2000)).length < 600);
    assert.match(summarisePayload('y'.repeat(1000)), /1000 bytes/);
  });
  it('survives circular structures', () => {
    const a: Record<string, unknown> = { n: 1 };
    a.self = a;
    assert.doesNotThrow(() => redact(a));
  });
});
