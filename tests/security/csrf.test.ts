import '../helpers/test-env';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { csrfProtection } from '../../src/middleware/csrf.middleware';

function run(method: string, headers: Record<string, string>) {
  let err: unknown = 'not-called';
  const req = { method, get: (h: string) => headers[h.toLowerCase()] } as never;
  csrfProtection(req, {} as never, (e?: unknown) => (err = e));
  return err as { code?: string } | undefined;
}

describe('CSRF protection', () => {
  it('allows safe methods without the header', () => assert.equal(run('GET', {}), undefined));
  it('blocks state-changing requests without X-Requested-With', () => assert.equal(run('POST', {})?.code, 'CSRF_REJECTED'));
  it('blocks a foreign Origin even with the header', () => assert.equal(run('DELETE', { 'x-requested-with': 'XMLHttpRequest', origin: 'https://evil.example' })?.code, 'CSRF_REJECTED'));
  it('allows the configured frontend origin', () => assert.equal(run('PUT', { 'x-requested-with': 'XMLHttpRequest', origin: 'http://localhost:5173' }), undefined));
});
