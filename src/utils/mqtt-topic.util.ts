import type { DataType } from '../constants/app.constants';
import { MQTT_LIMITS } from '../constants/mqtt.constants';

/**
 * Pure MQTT helpers: topic validation and matching, the proposed topic
 * convention, payload encoding and value coercion. No I/O here so it can be
 * unit-tested in isolation.
 *
 * Convention (proposed, configurable root; the LMS MQTT block is the
 * authority on real topics and variables may use custom topics under the
 * device's prefix):
 *   {root}/{hardwareId}/telemetry/{key}   device → platform
 *   {root}/{hardwareId}/command/{key}     platform → device
 *   {root}/{hardwareId}/ack/{key}         device acknowledgement
 *   {root}/{hardwareId}/availability      {"state":"online"|"offline"|…} (Last Will)
 */

const TOPIC_CHARS = /^[A-Za-z0-9_\-./]+$/;
export const HARDWARE_ID = /^[a-z0-9][a-z0-9-]{2,47}$/;

/** Validate a concrete (publish/variable) topic. Returns a user-facing problem or null. */
export function validateTopic(topic: string): string | null {
  if (!topic || !topic.trim()) return 'Enter a topic.';
  if (topic.length > MQTT_LIMITS.MAX_TOPIC_LENGTH) return `Keep topics under ${MQTT_LIMITS.MAX_TOPIC_LENGTH} characters.`;
  if (/\s/.test(topic)) return 'Topics cannot contain spaces.';
  if (/[+#]/.test(topic)) return 'Wildcards (+, #) are only allowed in subscriptions.';
  if (topic.startsWith('/') || topic.endsWith('/')) return 'Remove the leading or trailing “/”.';
  if (topic.includes('//')) return 'Topics cannot contain empty levels (“//”).';
  if (topic.startsWith('$')) return 'Topics starting with “$” are reserved by the broker.';
  if (!TOPIC_CHARS.test(topic)) return 'Use letters, digits, “_”, “-”, “.” and “/” only.';
  if (topic.split('/').length > MQTT_LIMITS.MAX_TOPIC_LEVELS) return `Use at most ${MQTT_LIMITS.MAX_TOPIC_LEVELS} topic levels.`;
  return null;
}

/** MQTT filter matching with `+` and `#`. */
export function topicMatches(filter: string, topic: string): boolean {
  if (filter === '#') return !topic.startsWith('$');
  return levelsMatch(filter.split('/'), topic.split('/'));
}

function levelsMatch(f: readonly string[], t: readonly string[]): boolean {
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

export const isWildcardFilter = (filter: string) => filter.includes('+') || filter.includes('#');

/** Bytes a SUBSCRIBE packet (MQTT 3.1.1) carrying these filters takes: fixed header (≤5) + packet id (2) + per filter length (2) + topic + QoS (1). */
export const subscribePacketBytes = (filters: readonly string[]) =>
  filters.reduce((n, f) => n + 2 + Buffer.byteLength(f, 'utf8') + 1, 5 + 2);

/**
 * Splits filters into groups whose SUBSCRIBE packet stays within maxBytes,
 * so resubscribing hundreds of filters after a reconnect never trips the
 * broker's max_packet_size (which drops the connection, not just the packet).
 * A filter too big on its own still gets its own group.
 */
export function chunkSubscribeFilters(filters: readonly string[], maxBytes: number = MQTT_LIMITS.SUBSCRIBE_PACKET_MAX_BYTES): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let size = subscribePacketBytes([]);
  for (const f of filters) {
    const cost = 2 + Buffer.byteLength(f, 'utf8') + 1;
    if (cur.length && size + cost > maxBytes) {
      chunks.push(cur);
      cur = [];
      size = subscribePacketBytes([]);
    }
    cur.push(f);
    size += cost;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * Subscription filter → handlers, built for the per-message hot path. Exact
 * filters are a Map lookup; only wildcard filters (a handful: the ingest
 * and simulator roots, `<prefix>/#` for off-root devices) are matched level
 * by level, against levels split once at subscribe time.
 */
export class FilterIndex<H> {
  private exact = new Map<string, Set<H>>();
  private wild = new Map<string, { levels: string[]; set: Set<H> }>();

  /** Returns true when the filter is new (the caller subscribes it at the broker). */
  add(filter: string, handler: H): boolean {
    const existing = this.setOf(filter);
    if (existing) {
      existing.add(handler);
      return false;
    }
    const set = new Set([handler]);
    if (isWildcardFilter(filter)) this.wild.set(filter, { levels: filter.split('/'), set });
    else this.exact.set(filter, set);
    return true;
  }

  /** Returns true when the filter has no handlers left (the caller unsubscribes it). */
  remove(filter: string, handler: H): boolean {
    const set = this.setOf(filter);
    if (!set) return false;
    set.delete(handler);
    if (set.size) return false;
    this.exact.delete(filter);
    this.wild.delete(filter);
    return true;
  }

  has = (filter: string) => this.exact.has(filter) || this.wild.has(filter);
  filters = () => [...this.exact.keys(), ...this.wild.keys()];
  get size() {
    return this.exact.size + this.wild.size;
  }
  get wildcardCount() {
    return this.wild.size;
  }

  clear(): void {
    this.exact.clear();
    this.wild.clear();
  }

  /** Calls `fn` once per filter matching the concrete topic. */
  forEachMatch(topic: string, fn: (filter: string, handlers: Set<H>) => void): void {
    const exact = this.exact.get(topic);
    if (exact) fn(topic, exact);
    if (!this.wild.size) return;
    const t = topic.split('/');
    for (const [filter, w] of this.wild) {
      if (filter === '#' ? !topic.startsWith('$') : levelsMatch(w.levels, t)) fn(filter, w.set);
    }
  }

  private setOf(filter: string): Set<H> | undefined {
    return this.exact.get(filter) ?? this.wild.get(filter)?.set;
  }
}

/**
 * Device topic prefix → device id. A topic is resolved by walking its OWN
 * prefixes, longest first (O(topic levels) Map lookups), instead of testing
 * every device's prefix. Same answer as "longest registered prefix the topic
 * is under" (see isUnderPrefix).
 */
export class PrefixIndex {
  private map = new Map<string, string>();

  set(prefix: string, id: string): void {
    this.map.set(prefix, id);
  }

  /** Removes the prefix, only if it still belongs to `id` when one is given. */
  delete(prefix: string, id?: string): void {
    if (id === undefined || this.map.get(prefix) === id) this.map.delete(prefix);
  }

  get size() {
    return this.map.size;
  }

  resolve(topic: string): string | null {
    for (let i = topic.lastIndexOf('/'); i > 0; i = topic.lastIndexOf('/', i - 1)) {
      if (i === topic.length - 1) continue; // empty last level: not *under* that prefix
      const id = this.map.get(topic.slice(0, i));
      if (id !== undefined) return id;
    }
    return null;
  }
}

export const isUnderPrefix = (topic: string, prefix: string): boolean => topic.startsWith(`${prefix}/`) && topic.length > prefix.length + 1;

export const defaultDevicePrefix = (root: string, hardwareId: string) => `${root}/${hardwareId}`;

export const conventionalTopics = (prefix: string, key: string) => ({
  telemetry: `${prefix}/telemetry/${key}`,
  command: `${prefix}/command/${key}`,
  ack: `${prefix}/ack/${key}`,
  availability: `${prefix}/availability`,
});

export function suggestTopics(prefix: string, key: string, direction: 'telemetry' | 'command' | 'bidirectional') {
  const t = conventionalTopics(prefix, key);
  return {
    stateTopic: direction !== 'command' ? t.telemetry : undefined,
    commandTopic: direction !== 'telemetry' ? t.command : undefined,
  };
}

export type DeviceTopicKind = 'telemetry' | 'command' | 'ack' | 'availability' | 'other';

/** Classify a topic relative to a device prefix. Returns null when the topic is outside the prefix. */
export function classifyDeviceTopic(topic: string, prefix: string): { kind: DeviceTopicKind; key?: string } | null {
  if (!isUnderPrefix(topic, prefix)) return null;
  const rest = topic.slice(prefix.length + 1).split('/');
  if (rest.length === 1 && rest[0] === 'availability') return { kind: 'availability' };
  if (rest.length === 2 && (rest[0] === 'telemetry' || rest[0] === 'command' || rest[0] === 'ack')) return { kind: rest[0], key: rest[1] };
  if (rest[rest.length - 1] === 'ack') return { kind: 'ack' };
  return { kind: 'other' };
}

/** The topic a device acknowledges a command on. */
export function ackTopicFor(commandTopic: string, prefix: string): string {
  const c = classifyDeviceTopic(commandTopic, prefix);
  if (c?.kind === 'command' && c.key) return `${prefix}/ack/${c.key}`;
  return `${commandTopic}/ack`;
}

/** Inverse of ackTopicFor. */
export function commandTopicForAck(ackTopic: string, prefix: string): string | null {
  const c = classifyDeviceTopic(ackTopic, prefix);
  if (!c || c.kind !== 'ack') return null;
  if (c.key) return `${prefix}/command/${c.key}`;
  return ackTopic.slice(0, -'/ack'.length);
}

/* ------------------------------------------------------------- payloads */

export const byteLength = (s: string) => Buffer.byteLength(s, 'utf8');

export function encodeValue(value: unknown, unit?: string): string {
  return JSON.stringify(unit ? { value, unit } : { value });
}

/** `{"value": x}` → x; any other JSON → itself; non-JSON → the raw string. */
export function decodeValue(payload: string): unknown {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'value' in (parsed as object)) return (parsed as { value: unknown }).value;
    return parsed;
  } catch {
    return payload;
  }
}

export type AckOutcome = { ok: true } | { ok: false; error: string };

/**
 * A device's acknowledgement (contract C): `{"value":…,"ok":true}` = applied,
 * `{"ok":false,"error":"…"}` = refused. A missing "ok" (older firmware) or a
 * non-JSON payload counts as acknowledged.
 */
export function parseAck(payload: string): AckOutcome {
  try {
    const p = JSON.parse(payload) as unknown;
    if (p && typeof p === 'object' && !Array.isArray(p) && (p as { ok?: unknown }).ok === false) {
      const raw = (p as { error?: unknown }).error;
      // eslint-disable-next-line no-control-regex
      const error = typeof raw === 'string' ? raw.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 120) : '';
      return { ok: false, error: error || 'The device rejected the command.' };
    }
  } catch {
    /* not JSON → acknowledged */
  }
  return { ok: true };
}

function depthOf(v: unknown, d = 0): number {
  if (d > 10 || v === null || typeof v !== 'object') return d;
  let max = d;
  for (const x of Object.values(v as object)) max = Math.max(max, depthOf(x, d + 1));
  return max;
}

/** Validate an inbound or outbound payload: size limit, and if JSON, bounded depth. */
export function validatePayload(payload: string, maxBytes: number = MQTT_LIMITS.MAX_PAYLOAD_BYTES): string | null {
  if (byteLength(payload) > maxBytes) return `Payload exceeds ${maxBytes} bytes.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000E-\u001F]/.test(payload)) return 'Payload contains control characters.';
  const trimmed = payload.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      if (depthOf(JSON.parse(trimmed)) > 4) return 'Payload JSON is nested too deeply.';
    } catch {
      return 'Payload looks like JSON but does not parse.';
    }
  }
  return null;
}

export const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

const toNumber = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

const toBool = (v: unknown): boolean | null => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (['true', '1', 'on', 'yes'].includes(s)) return true;
    if (['false', '0', 'off', 'no'].includes(s)) return false;
  }
  return null;
};

/**
 * Coerce a command value to the variable's data type, enforcing min/max.
 * Returns `{ value }` or `{ error }` — commands with the wrong type are rejected, not guessed.
 */
export function coerceCommandValue(raw: unknown, dataType: DataType, range: { min?: number; max?: number } = {}): { value?: unknown; error?: string } {
  switch (dataType) {
    case 'boolean': {
      const b = toBool(raw);
      return b === null ? { error: 'Expected true or false.' } : { value: b };
    }
    case 'integer':
    case 'float': {
      const n = toNumber(raw);
      if (n === null) return { error: 'Expected a number.' };
      const v = dataType === 'integer' ? Math.round(n) : n;
      if (range.min !== undefined && v < range.min) return { error: `Value must be ≥ ${range.min}.` };
      if (range.max !== undefined && v > range.max) return { error: `Value must be ≤ ${range.max}.` };
      return { value: v };
    }
    case 'color':
      return isHexColor(raw) ? { value: raw.toLowerCase() } : { error: 'Expected a colour like #6262f5.' };
    case 'string':
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return { error: 'Expected text.' };
      return String(raw).length > 256 ? { error: 'Text is too long (max 256).' } : { value: String(raw) };
    case 'json':
      if (raw === null || typeof raw !== 'object') return { error: 'Expected a JSON object.' };
      if (depthOf(raw) > 4) return { error: 'JSON value is nested too deeply.' };
      return { value: raw };
  }
}

/** Numeric value for telemetry history (booleans become 0/1), else null. */
export function numericSample(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return toNumber(value);
}
