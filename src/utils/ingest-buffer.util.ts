/**
 * Pure building blocks of the MQTT ingest write path. No I/O of their own —
 * the writes are injected — so they can be unit-tested with fakes.
 *
 *   TelemetrySampler  at most one persisted telemetry document per topic per interval
 *   BatchWriter       bounded buffer + single-flight, chunked, retried batch inserts
 *   LatestCoalescer   latest value per (device, topic), written as one batch per tick
 */

/**
 * Telemetry persistence sampling ("newest wins at the next flush").
 *
 * Every sample replaces the one held for its key. At each flush, `due()`
 * releases the held sample of every key whose last write is at least
 * `intervalMs` ago. So a key is written at most once per interval, the
 * value written is the newest one seen, and a key's first sample is written
 * at the next flush (no extra delay). `intervalMs` 0 disables sampling:
 * `offer()` hands every sample straight back.
 */
export class TelemetrySampler<T> {
  private slots = new Map<string, { lastWrittenAt: number; held: T | null }>();
  /** Samples replaced by a newer one before they were written. */
  superseded = 0;

  constructor(
    readonly intervalMs: number,
    private readonly maxKeys = 100_000,
  ) {}

  /** Returns the sample when it must be written now (sampling off, or too many keys), else holds it and returns null. */
  offer(key: string, sample: T): T | null {
    if (this.intervalMs <= 0) return sample;
    const slot = this.slots.get(key);
    if (!slot) {
      if (this.slots.size >= this.maxKeys) return sample; // bounded memory; the writer's buffer bounds the rest
      this.slots.set(key, { lastWrittenAt: Number.NEGATIVE_INFINITY, held: sample });
      return null;
    }
    if (slot.held) this.superseded++;
    slot.held = sample;
    return null;
  }

  /** Held samples whose interval has elapsed at `now` (marked written). Idle keys are forgotten. */
  due(now: number): T[] {
    const out: T[] = [];
    for (const [key, slot] of this.slots) {
      if (now - slot.lastWrittenAt < this.intervalMs) continue;
      if (slot.held) {
        out.push(slot.held);
        slot.held = null;
        slot.lastWrittenAt = now;
      } else {
        this.slots.delete(key); // nothing held and the interval is over: the next sample is due anyway
      }
    }
    return out;
  }

  /** Everything held, regardless of interval (shutdown). */
  drain(): T[] {
    const out: T[] = [];
    for (const slot of this.slots.values()) if (slot.held) out.push(slot.held);
    this.slots.clear();
    return out;
  }

  get size() {
    return this.slots.size;
  }
}

export interface BatchWriterOptions<T> {
  write: (items: T[]) => Promise<unknown>;
  /** Most items buffered (in-flight batch excluded). The oldest are dropped beyond it. */
  maxBuffered: number;
  chunkSize: number;
  /** Attempts per item before it is given up (counted in `stats.failed`). */
  maxAttempts: number;
  onError?: (err: unknown, info: { count: number; requeued: number; gaveUp: number }) => void;
  onOverflow?: (dropped: number) => void;
}

/**
 * Bounded write buffer with a single-flight flush: a flush never overlaps
 * the previous one (callers share the in-flight promise), items are written
 * in chunks, and a failed chunk is put back at the FRONT of the buffer (with
 * the chunks not yet tried) for the next flush, until `maxAttempts`.
 * Nothing is dropped without being counted.
 */
export class BatchWriter<T> {
  private buffer: Array<{ item: T; tries: number }> = [];
  private inFlight: Promise<void> | null = null;
  readonly stats = { written: 0, overflow: 0, failed: 0, errors: 0 };

  constructor(private readonly opts: BatchWriterOptions<T>) {}

  push(item: T): void {
    this.buffer.push({ item, tries: 0 });
    this.trim();
  }

  get size() {
    return this.buffer.length;
  }

  get busy() {
    return this.inFlight !== null;
  }

  /** Write what is buffered now. While a flush is running, returns that flush instead of starting another. */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.buffer.length) return Promise.resolve();
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Wait for the running flush, then write everything buffered by now (shutdown, seeding). */
  async flushNow(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    await this.flush();
  }

  private async run(): Promise<void> {
    const batch = this.buffer;
    this.buffer = [];
    for (let i = 0; i < batch.length; i += this.opts.chunkSize) {
      const chunk = batch.slice(i, i + this.opts.chunkSize);
      try {
        await this.opts.write(chunk.map((e) => e.item));
        this.stats.written += chunk.length;
      } catch (err) {
        this.stats.errors++;
        const retry: Array<{ item: T; tries: number }> = [];
        let gaveUp = 0;
        for (const e of chunk) {
          if (e.tries + 1 < this.opts.maxAttempts) retry.push({ item: e.item, tries: e.tries + 1 });
          else gaveUp++;
        }
        this.stats.failed += gaveUp;
        const untried = batch.slice(i + this.opts.chunkSize);
        // Stop on the first failure (do not hammer a struggling database); keep order: failed, untried, newer.
        this.buffer = [...retry, ...untried, ...this.buffer];
        this.trim();
        this.opts.onError?.(err, { count: chunk.length, requeued: retry.length + untried.length, gaveUp });
        return;
      }
    }
  }

  private trim(): void {
    const over = this.buffer.length - this.opts.maxBuffered;
    if (over <= 0) return;
    this.buffer.splice(0, over);
    this.stats.overflow += over;
    this.opts.onOverflow?.(over);
  }
}

export interface LatestCoalescerOptions {
  /** One write per tick for every dirty group (e.g. one Redis pipeline). Must reject on failure. */
  write: (dirty: Map<string, Map<string, string>>) => Promise<unknown>;
  maxEntries: number;
  onError?: (err: unknown) => void;
}

/**
 * Latest value per (group, field) — for Redis: (device, topic) — kept in
 * memory and written in one batch per tick instead of one round trip per
 * message. Newest value wins; a failed write is merged back under any newer
 * values. A new (group, field) beyond `maxEntries` is dropped and counted.
 */
export class LatestCoalescer {
  private dirty = new Map<string, Map<string, string>>();
  private entries = 0;
  private inFlight: Promise<void> | null = null;
  readonly stats = { written: 0, dropped: 0, errors: 0 };

  constructor(private readonly opts: LatestCoalescerOptions) {}

  set(group: string, field: string, value: string): void {
    let g = this.dirty.get(group);
    if (!g) {
      if (this.entries >= this.opts.maxEntries) {
        this.stats.dropped++;
        return;
      }
      g = new Map();
      this.dirty.set(group, g);
    }
    if (!g.has(field)) {
      if (this.entries >= this.opts.maxEntries) {
        this.stats.dropped++;
        return;
      }
      this.entries++;
    }
    g.set(field, value);
  }

  /** Forget pending values for these groups (their keys are being deleted). */
  discard(groups: string[]): void {
    for (const id of groups) {
      const g = this.dirty.get(id);
      if (!g) continue;
      this.entries -= g.size;
      this.dirty.delete(id);
    }
  }

  get size() {
    return this.entries;
  }

  /** Write everything dirty. Single-flight: while a write runs, values keep accumulating for the next tick. */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.entries) return Promise.resolve();
    const batch = this.dirty;
    const count = this.entries;
    this.dirty = new Map();
    this.entries = 0;
    this.inFlight = (async () => {
      try {
        await this.opts.write(batch);
        this.stats.written += count;
      } catch (err) {
        this.stats.errors++;
        for (const [group, fields] of batch) for (const [field, value] of fields) if (!this.dirty.get(group)?.has(field)) this.set(group, field, value);
        this.opts.onError?.(err);
      }
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async flushNow(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    await this.flush();
  }
}
