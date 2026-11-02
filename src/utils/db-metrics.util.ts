/**
 * In-process counters for every DAO call (including the `quiet` ones that
 * are not logged). Cheap: one Map update per operation. Exposed to admins at
 * GET /admin/metrics/db so read/write volume can be measured, not guessed.
 * Counts are per API process and reset on restart (or via POST …/reset).
 */

const WRITE = /^(create|insert|update|set|touch|delete|replace|add|remove|mark|claim|release|revert|record|pull|unbind|rename)/i;

export type OpKind = 'read' | 'write';
export const kindOf = (operation: string): OpKind => (WRITE.test(operation) ? 'write' : 'read');

interface Stat {
  entity: string;
  operation: string;
  kind: OpKind;
  count: number;
  /** Documents written by bulk inserts (insertMany / createMany), when known. */
  docs: number;
  totalMs: number;
  maxMs: number;
  errors: number;
}

const stats = new Map<string, Stat>();
let since = Date.now();

export const dbMetrics = {
  record(entity: string, operation: string, durationMs: number, ok: boolean, docs?: number) {
    const key = `${entity}.${operation}`;
    let s = stats.get(key);
    if (!s) {
      s = { entity, operation, kind: kindOf(operation), count: 0, docs: 0, totalMs: 0, maxMs: 0, errors: 0 };
      stats.set(key, s);
    }
    s.count++;
    s.totalMs += durationMs;
    if (durationMs > s.maxMs) s.maxMs = durationMs;
    if (!ok) s.errors++;
    if (docs) s.docs += docs;
  },

  snapshot() {
    const elapsedSec = Math.max(1, (Date.now() - since) / 1000);
    const perMin = (n: number) => Math.round((n / elapsedSec) * 60 * 10) / 10;
    const ops = Array.from(stats.values())
      .map((s) => ({ ...s, avgMs: Math.round(s.totalMs / s.count), perMinute: perMin(s.count) }))
      .sort((a, b) => b.count - a.count);
    const sum = (k: OpKind) => ops.filter((o) => o.kind === k).reduce((n, o) => n + o.count, 0);
    const reads = sum('read');
    const writes = sum('write');
    return {
      since,
      elapsedSec: Math.round(elapsedSec),
      totals: { reads, writes, all: reads + writes, readsPerMinute: perMin(reads), writesPerMinute: perMin(writes), docsWritten: ops.reduce((n, o) => n + o.docs, 0) },
      ops: ops.map(({ totalMs: _t, ...o }) => o),
    };
  },

  reset() {
    stats.clear();
    since = Date.now();
  },
};
