import '../helpers/test-env';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encryptionService } from '../../src/services/shared/encryption.service';
import { AppError, classifyDbError, toAppError } from '../../src/utils/error.util';
import { parseDuration } from '../../src/utils/date.util';

describe('error mapping', () => {
  it('maps duplicate keys to 409 DUPLICATE with field names only', () => {
    const e = toAppError(Object.assign(new Error('E11000 dup key { email: "a@b.co" }'), { code: 11000, keyPattern: { email: 1 } }));
    assert.equal(e.status, 409);
    assert.equal(e.code, 'DUPLICATE');
    assert.deepEqual(e.details, { fields: ['email'] });
    assert.doesNotMatch(e.message, /a@b\.co/);
  });
  it('maps database outages to 503', () => assert.equal(toAppError(Object.assign(new Error('x'), { name: 'MongoServerSelectionError' })).status, 503));
  it('maps body-parser failures', () => {
    assert.equal(toAppError({ type: 'entity.too.large' }).status, 413);
    assert.equal(toAppError({ type: 'entity.parse.failed' }).code, 'INVALID_JSON');
  });
  it('hides unexpected errors', () => {
    const e = toAppError(new Error('connection string mongodb://user:pass@host'));
    assert.equal(e.status, 500);
    assert.equal(e.expose, false);
    assert.doesNotMatch(e.message, /pass/);
  });
  it('keeps typed AppErrors', () => assert.equal(toAppError(new AppError(418, 'CONFLICT', 'x')).status, 418));
  it('classifies without reading query contents', () => assert.equal(classifyDbError({ name: 'CastError' }), 'cast'));
});

describe('durations', () => {
  it('parses 10m and 7d', () => {
    assert.equal(parseDuration('10m'), 600);
    assert.equal(parseDuration('7d'), 604800);
    assert.equal(parseDuration('ten'), null);
  });
});

describe('authenticated encryption (AES-256-GCM)', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptionService.encrypt('192.0.2.1');
    const b = encryptionService.encrypt('192.0.2.1');
    assert.notEqual(a, b);
    assert.equal(encryptionService.decrypt(a), '192.0.2.1');
  });
  it('detects tampering', () => {
    const t = encryptionService.encrypt('secret');
    const parts = t.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    assert.equal(encryptionService.decrypt(parts.join('.')), null);
  });
  it('pseudonymises consistently without revealing the input', () => {
    assert.equal(encryptionService.pseudonymise('10.0.0.1'), encryptionService.pseudonymise('10.0.0.1'));
    assert.doesNotMatch(encryptionService.pseudonymise('10.0.0.1'), /10\.0\.0\.1/);
  });
});
