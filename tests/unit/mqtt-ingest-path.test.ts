import '../helpers/test-env';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { Types } from 'mongoose';
import type { Response } from 'express';
import { deviceDao } from '../../src/dao/device.dao';
import { variableDao } from '../../src/dao/variable.dao';
import type { DeviceDoc } from '../../src/models/device.model';
import { activityService } from '../../src/services/shared/activity.service';
import { deviceRegistry } from '../../src/services/shared/device-registry.service';
import { mqttIngestService } from '../../src/services/shared/mqtt-ingest.service';
import { realtimeService } from '../../src/services/shared/realtime.service';
import { BatchWriter, LatestCoalescer, TelemetrySampler } from '../../src/utils/ingest-buffer.util';
import { FilterIndex, PrefixIndex, isUnderPrefix, topicMatches } from '../../src/utils/mqtt-topic.util';

const R = 'kokoon/devices';
const tick = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('FilterIndex (subscription dispatch)', () => {
  const matched = (idx: FilterIndex<string>, topic: string) => {
    const out: string[] = [];
    idx.forEachMatch(topic, (f, set) => out.push(...[...set].map((h) => `${f}=>${h}`)));
    return out.sort();
  };

  it('looks exact filters up directly and walks only the wildcard ones', () => {
    const idx = new FilterIndex<string>();
    assert.equal(idx.add(`${R}/+/telemetry/+`, 'ingest'), true);
    assert.equal(idx.add(`${R}/+/telemetry/+`, 'other'), false, 'second handler on the same filter is not a new subscription');
    idx.add(`${R}/hw-1/custom/state`, 'ingest');
    idx.add('lab/hw-2/#', 'ingest');
    assert.equal(idx.size, 3);
    assert.equal(idx.wildcardCount, 2);
    assert.deepEqual(matched(idx, `${R}/hw-1/telemetry/temp`), [`${R}/+/telemetry/+=>ingest`, `${R}/+/telemetry/+=>other`]);
    assert.deepEqual(matched(idx, `${R}/hw-1/custom/state`), [`${R}/hw-1/custom/state=>ingest`]);
    assert.deepEqual(matched(idx, 'lab/hw-2/a/b/c'), ['lab/hw-2/#=>ingest']);
    assert.deepEqual(matched(idx, `${R}/hw-1/command/led`), []);
  });

  it('agrees with topicMatches for every filter shape', () => {
    const filters = ['#', 'a/#', 'a/+', 'a/+/c', '+/b/#', 'a/b/c', 'a/b', '+', 'a/+/+/d'];
    const topics = ['a', 'a/b', 'a/b/c', 'a/x/c', 'a/b/c/d', 'z/b/q', '$SYS/x', 'a/b/c/d/e'];
    const idx = new FilterIndex<string>();
    for (const f of filters) idx.add(f, 'h');
    for (const t of topics) {
      const got: string[] = [];
      idx.forEachMatch(t, (f) => got.push(f));
      assert.deepEqual(got.sort(), filters.filter((f) => topicMatches(f, t)).sort(), t);
    }
  });

  it('reports when the last handler of a filter is removed', () => {
    const idx = new FilterIndex<string>();
    idx.add('a/b', 'x');
    idx.add('a/b', 'y');
    assert.equal(idx.remove('a/b', 'x'), false);
    assert.equal(idx.remove('a/b', 'y'), true);
    assert.equal(idx.has('a/b'), false);
    assert.equal(idx.remove('a/b', 'y'), false, 'removing from an unknown filter is a no-op');
  });
});

describe('PrefixIndex (topic → device)', () => {
  const prefixes = [`${R}/hw-a`, `${R}/hw-ab`, `${R}/hw-a/sub`, 'lab/bench', 'lab'];
  const linear = (topic: string) => [...prefixes].sort((a, b) => b.length - a.length).find((p) => isUnderPrefix(topic, p)) ?? null;
  const idx = new PrefixIndex();
  for (const p of prefixes) idx.set(p, p);

  it('resolves the longest registered prefix, exactly like the old linear scan', () => {
    const topics = [
      `${R}/hw-a/telemetry/t`, `${R}/hw-ab/telemetry/t`, `${R}/hw-a/sub/x`, `${R}/hw-a/sub`, `${R}/hw-abc/telemetry/t`,
      `${R}/hw-a`, `${R}/hw-a/`, `${R}/hw-a/sub/`, 'lab/bench/x', 'lab/x', 'lab', 'lab/', '/lab/x', 'other/thing', '',
    ];
    for (const t of topics) assert.equal(idx.resolve(t), linear(t), JSON.stringify(t));
  });

  it('never matches a look-alike sibling prefix', () => {
    assert.equal(idx.resolve(`${R}/hw-a-evil/telemetry/t`), null);
  });

  it('only deletes a prefix still owned by the given id', () => {
    const p = new PrefixIndex();
    p.set('x/y', 'new');
    p.delete('x/y', 'old');
    assert.equal(p.resolve('x/y/z'), 'new');
    p.delete('x/y', 'new');
    assert.equal(p.resolve('x/y/z'), null);
  });
});

describe('TelemetrySampler (persistence sampling)', () => {
  it('writes each topic at most once per interval, the newest value winning', () => {
    const s = new TelemetrySampler<string>(5000);
    assert.equal(s.offer('t', 'v1'), null);
    assert.equal(s.offer('t', 'v2'), null);
    assert.deepEqual(s.due(1000), ['v2'], 'first sample of a topic goes out at the next flush');
    s.offer('t', 'v3');
    assert.deepEqual(s.due(2000), [], 'interval not over');
    s.offer('t', 'v4');
    assert.deepEqual(s.due(5999), []);
    assert.deepEqual(s.due(6000), ['v4']);
    assert.equal(s.superseded, 2);
  });

  it('keeps topics independent and forgets idle ones', () => {
    const s = new TelemetrySampler<string>(1000);
    s.offer('a', 'a1');
    s.offer('b', 'b1');
    assert.deepEqual(s.due(0).sort(), ['a1', 'b1']);
    assert.equal(s.size, 2);
    s.due(1000);
    assert.equal(s.size, 0, 'nothing held and the interval is over');
  });

  it('interval 0 persists every message, and drain() returns what is held', () => {
    assert.equal(new TelemetrySampler<string>(0).offer('t', 'x'), 'x');
    const s = new TelemetrySampler<string>(60_000);
    s.offer('a', 'a1');
    s.due(0);
    s.offer('a', 'a2');
    assert.deepEqual(s.drain(), ['a2']);
  });

  it('bounds the number of tracked topics', () => {
    const s = new TelemetrySampler<string>(1000, 2);
    s.offer('a', 'a');
    s.offer('b', 'b');
    assert.equal(s.offer('c', 'c'), 'c', 'beyond the bound a sample is written directly');
  });
});

describe('BatchWriter (serialized flush)', () => {
  it('never runs two writes at once and writes in chunks', async () => {
    let active = 0;
    let maxActive = 0;
    const gates: Array<ReturnType<typeof deferred>> = [];
    const written: number[][] = [];
    const w = new BatchWriter<number>({
      write: async (items) => {
        active++;
        maxActive = Math.max(maxActive, active);
        const g = deferred();
        gates.push(g);
        await g.promise;
        written.push(items);
        active--;
      },
      maxBuffered: 100, chunkSize: 2, maxAttempts: 3,
    });
    [1, 2, 3].forEach((n) => w.push(n));
    const a = w.flush();
    w.push(4);
    const b = w.flush();
    assert.equal(a, b, 'a flush during a flush shares the running one');
    assert.equal(w.busy, true);
    gates[0].resolve();
    await tick();
    gates[1].resolve();
    await a;
    assert.deepEqual(written, [[1, 2], [3]]);
    assert.equal(w.size, 1, 'the item pushed meanwhile waits for the next flush');
    const c = w.flush();
    await tick();
    gates[2].resolve();
    await c;
    assert.deepEqual(written.at(-1), [4]);
    assert.equal(maxActive, 1);
    assert.equal(w.stats.written, 4);
  });

  it('puts a failed chunk back in front and gives up after maxAttempts, counting it', async () => {
    let fail = true;
    const seen: number[][] = [];
    const errors: Array<{ count: number; requeued: number; gaveUp: number }> = [];
    const w = new BatchWriter<number>({
      write: async (items) => {
        seen.push(items);
        if (fail) throw new Error('mongo down');
      },
      maxBuffered: 100, chunkSize: 2, maxAttempts: 2, onError: (_e, info) => errors.push(info),
    });
    [1, 2, 3].forEach((n) => w.push(n));
    await w.flush();
    assert.deepEqual(seen, [[1, 2]], 'stops at the first failing chunk');
    assert.equal(w.size, 3, 'failed + untried items are kept');
    w.push(4);
    await w.flush();
    assert.equal(w.stats.failed, 2, 'items 1 and 2 used both attempts');
    assert.deepEqual(errors.map((e) => e.gaveUp), [0, 2]);
    fail = false;
    await w.flushNow();
    assert.deepEqual(seen.at(-1), [3, 4]);
    assert.equal(w.size, 0);
    assert.equal(w.stats.written, 2);
  });

  it('bounds the buffer, dropping (and counting) the oldest', () => {
    const dropped: number[] = [];
    const w = new BatchWriter<number>({ write: async () => undefined, maxBuffered: 3, chunkSize: 10, maxAttempts: 1, onOverflow: (n) => dropped.push(n) });
    for (let i = 0; i < 5; i++) w.push(i);
    assert.equal(w.size, 3);
    assert.equal(w.stats.overflow, 2);
    assert.deepEqual(dropped, [1, 1]);
  });
});

describe('LatestCoalescer (Redis latest values)', () => {
  it('writes the newest value per (device, topic) in one batch, and merges a failed batch back under newer values', async () => {
    const batches: Array<Record<string, Record<string, string>>> = [];
    let fail = false;
    const c = new LatestCoalescer({
      write: async (dirty) => {
        if (fail) throw new Error('redis down');
        batches.push(Object.fromEntries([...dirty].map(([k, v]) => [k, Object.fromEntries(v)])));
      },
      maxEntries: 10,
    });
    c.set('d1', 't', '1');
    c.set('d1', 't', '2');
    c.set('d2', 't', '9');
    await c.flush();
    assert.deepEqual(batches, [{ d1: { t: '2' }, d2: { t: '9' } }]);
    fail = true;
    c.set('d1', 't', '3');
    const p = c.flush();
    c.set('d1', 't', '4'); // arrives while the failing write is in flight
    await p;
    fail = false;
    await c.flush();
    assert.deepEqual(batches.at(-1), { d1: { t: '4' } }, 'the newer value is not overwritten by the failed older one');
    c.set('d3', 't', 'x');
    c.discard(['d3']);
    assert.equal(c.size, 0);
  });
});

/* ------------------------------------------------- registry (fake DAO) */

function fakeDevice(hw: string, over: Partial<DeviceDoc> = {}): DeviceDoc {
  return {
    _id: new Types.ObjectId(), ownerId: new Types.ObjectId(), name: hw, hardwareId: hw, topicPrefix: `${R}/${hw}`, board: 'ESP32', origin: 'lms', simulated: false, status: 'active',
    lmsProgram: null, capabilities: [], registeredBy: null, connectionState: 'waiting', connectionSince: null, lastSeenAt: null, ...over,
  } as unknown as DeviceDoc;
}

describe('deviceRegistry', () => {
  it('coalesces refreshes and runs exactly one follow-up when asked during a load', async () => {
    const db: DeviceDoc[] = [fakeDevice('kk-one')];
    const gates: Array<ReturnType<typeof deferred>> = [];
    const origList = deviceDao.listActive;
    const origVars = variableDao.listByDevices;
    let loads = 0;
    deviceDao.listActive = (async () => {
      loads++;
      const snapshot = [...db]; // what the database held when this load read it
      const g = deferred();
      gates.push(g);
      await g.promise;
      return snapshot;
    }) as typeof deviceDao.listActive;
    variableDao.listByDevices = (async () => []) as unknown as typeof variableDao.listByDevices;
    try {
      const first = deviceRegistry.refresh();
      db.push(fakeDevice('kk-two')); // written after the running load read the database
      const second = deviceRegistry.refresh();
      const third = deviceRegistry.refresh();
      assert.equal(second, third, 'callers during a load share one follow-up');
      gates[0].resolve();
      await first;
      assert.equal(deviceRegistry.resolveByTopic(`${R}/kk-two/telemetry/t`), null, 'the first load missed it');
      await tick();
      gates[1].resolve();
      await second;
      assert.equal(loads, 2);
      assert.equal(deviceRegistry.resolveByTopic(`${R}/kk-two/telemetry/t`)?.hardwareId, 'kk-two');
      assert.equal(deviceRegistry.resolveByTopic(`${R}/kk-one/availability`)?.hardwareId, 'kk-one');
    } finally {
      deviceDao.listActive = origList;
      variableDao.listByDevices = origVars;
    }
  });

  it('upserts and removes single devices (routing follows a prefix change)', () => {
    const d = fakeDevice('kk-three');
    deviceRegistry.upsertDevice(d, []);
    assert.equal(deviceRegistry.resolveByTopic(`${R}/kk-three/telemetry/t`)?.hardwareId, 'kk-three');
    assert.ok(deviceRegistry.runtimeOf(String(d._id)));
    deviceRegistry.upsertDevice({ ...d, topicPrefix: 'lab/kk-three' } as DeviceDoc);
    assert.equal(deviceRegistry.resolveByTopic(`${R}/kk-three/telemetry/t`), null);
    assert.equal(deviceRegistry.resolveByTopic('lab/kk-three/x')?.hardwareId, 'kk-three');
    deviceRegistry.upsertDevice({ ...d, status: 'disabled' } as DeviceDoc);
    assert.equal(deviceRegistry.resolveByTopic('lab/kk-three/x'), null, 'a disabled device is removed');
    assert.equal(deviceRegistry.runtimeOf(String(d._id)), null);
  });

  it('a retained message does not count as a sign of life or a first telemetry', () => {
    const d = fakeDevice('kk-four');
    deviceRegistry.upsertDevice(d, []);
    const id = String(d._id);
    assert.deepEqual(deviceRegistry.markSeen(id, 1000, true, true), { first: false });
    assert.equal(deviceRegistry.runtimeOf(id)?.lastSeen, null);
    assert.equal(deviceRegistry.runtimeOf(id)?.telemetrySeen, true);
    deviceRegistry.removeDevice(id);
  });
});

describe('availability ingest', () => {
  it('an empty message (a retained "online" being cleared) is not a report from the board; a real one still is', () => {
    const d = fakeDevice('kk-five');
    const id = String(d._id);
    const topic = `${R}/kk-five/availability`;
    const orig = { setConnection: deviceDao.setConnection, touchLastSeen: deviceDao.touchLastSeen, record: activityService.record };
    deviceDao.setConnection = (async () => undefined) as unknown as typeof deviceDao.setConnection;
    deviceDao.touchLastSeen = (async () => undefined) as unknown as typeof deviceDao.touchLastSeen;
    activityService.record = (async () => undefined) as unknown as typeof activityService.record;
    try {
      deviceRegistry.upsertDevice(d, []);
      deviceRegistry.setState(id, 'disconnected');
      mqttIngestService.handleInbound({ topic, payload: '', qos: 1, retain: false });
      assert.equal(deviceRegistry.runtimeOf(id)?.state, 'disconnected', 'the clear does not turn it into "waiting"');
      assert.equal(deviceRegistry.runtimeOf(id)?.lastSeen, null, 'nor counts as a sign of life');
      assert.equal(mqttIngestService.stats().buffered, 0, 'nor is stored');
      mqttIngestService.handleInbound({ topic, payload: '{"state":"online"}', qos: 1, retain: false });
      assert.equal(deviceRegistry.runtimeOf(id)?.state, 'connected');
    } finally {
      deviceRegistry.removeDevice(id);
      Object.assign(deviceDao, { setConnection: orig.setConnection, touchLastSeen: orig.touchLastSeen });
      activityService.record = orig.record;
    }
  });
});

/* ------------------------------------------------- SSE hub (fake responses) */

class FakeRes extends EventEmitter {
  chunks: string[] = [];
  writable = true;
  writableLength = 0;
  ended = false;
  write(s: string) {
    this.chunks.push(s);
    if (!this.writable) this.writableLength += s.length;
    return this.writable;
  }
  end() {
    this.ended = true;
  }
  events = (type: string) => this.chunks.filter((c) => c.startsWith(`event: ${type}\n`)).length;
}

describe('realtimeService (SSE fan-out)', () => {
  const open = (userId: string, deviceIds: string[]) => {
    const res = new FakeRes();
    const close = realtimeService.register({ userId, sessionId: `s-${userId}`, res: res as unknown as Response, deviceIds, endAt: Date.now() + 600_000 });
    return { res, close };
  };

  it('delivers a device event only to the streams that own the device, following ownership changes', () => {
    const a = open('u-a', ['d1']);
    const b = open('u-b', ['d2']);
    realtimeService.toDevice('d1', { type: 'message', data: { x: 1 } } as never);
    assert.equal(a.res.events('message'), 1);
    assert.equal(b.res.events('message'), 0);
    realtimeService.setUserDevices('u-b', ['d1']);
    realtimeService.toDevice('d1', { type: 'message', data: { x: 2 } } as never);
    realtimeService.toDevice('d2', { type: 'message', data: { x: 3 } } as never);
    assert.equal(b.res.events('message'), 1, 'u-b now sees d1 and no longer d2');
    a.close();
    b.close();
    assert.equal(realtimeService.count(), 0);
  });

  it('skips the console feed for a congested stream until drain, but keeps state events', () => {
    const a = open('u-c', ['d9']);
    a.res.writable = false;
    realtimeService.toDevice('d9', { type: 'message', data: {} } as never); // write() returns false here
    realtimeService.toDevice('d9', { type: 'message', data: {} } as never); // skipped
    realtimeService.toDevice('d9', { type: 'device', data: {} } as never); // state: still sent
    assert.equal(a.res.events('message'), 1);
    assert.equal(a.res.events('device'), 1);
    a.res.writable = true;
    a.res.writableLength = 0;
    a.res.emit('drain');
    realtimeService.toDevice('d9', { type: 'message', data: {} } as never);
    assert.equal(a.res.events('message'), 2);
    assert.ok(realtimeService.stats().skipped >= 1);
    a.close();
  });

  it('closes a stream whose buffer grows past the limit, and jitters the retry hint', () => {
    const a = open('u-d', ['d8']);
    a.res.writable = false;
    a.res.writableLength = 10 * 1024 * 1024;
    realtimeService.toDevice('d8', { type: 'device', data: {} } as never);
    assert.equal(a.res.ended, true);
    assert.equal(realtimeService.count(), 0);
    const hints = new Set(Array.from({ length: 20 }, () => realtimeService.retryFrame()));
    assert.ok(hints.size > 1);
    for (const h of hints) assert.match(h, /^retry: \d{4}\n\n$/);
    realtimeService.closeAll();
  });
});
