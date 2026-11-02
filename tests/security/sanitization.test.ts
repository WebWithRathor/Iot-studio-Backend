import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findUnsafe, findUnsafeQuery, querySanitization } from '../../src/middleware/query-sanitization.middleware';

describe('NoSQL injection and prototype pollution guard', () => {
  it('rejects MongoDB operators anywhere in the body', () => {
    assert.ok(findUnsafe({ email: { $ne: null } }));
    assert.ok(findUnsafe({ widgets: [{ config: { $where: 'sleep(1000)' } }] }));
    assert.ok(findUnsafe({ $or: [{ a: 1 }] }));
  });
  it('rejects dotted keys (path injection)', () => assert.ok(findUnsafe({ 'settings.role': 'ADMIN' })));
  it('rejects prototype pollution keys', () => {
    assert.ok(findUnsafe(JSON.parse('{"__proto__": {"isAdmin": true}}')));
    assert.ok(findUnsafe({ constructor: { prototype: {} } }));
  });
  it('rejects nested objects in the query string', () => {
    assert.ok(findUnsafeQuery({ email: { $ne: '' } } as Record<string, unknown>));
    assert.equal(findUnsafeQuery(Object.assign(Object.create(null), { q: 'garden', sort: '-name' })), null);
    assert.equal(findUnsafeQuery({ ids: ['a', 'b'] }), null);
  });
  it('limits depth, width and array length', () => {
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 12; i++) deep = { n: deep };
    assert.ok(findUnsafe(deep));
    assert.ok(findUnsafe({ a: Array.from({ length: 501 }, () => 1) }));
    assert.ok(findUnsafe(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, i]))));
  });
  it('lets ordinary payloads through', () => assert.equal(findUnsafe({ name: 'Smart Room', widgets: [{ id: 'w1', config: { title: 'Temp $5 · 22.5°C' } }] }), null));
  it('middleware turns a problem into a 400 UNSAFE_INPUT error', () => {
    let received: unknown;
    querySanitization({ query: {}, params: {}, body: { password: { $gt: '' } } } as never, {} as never, (err?: unknown) => (received = err));
    assert.equal((received as { status: number; code: string }).status, 400);
    assert.equal((received as { code: string }).code, 'UNSAFE_INPUT');
  });
});
