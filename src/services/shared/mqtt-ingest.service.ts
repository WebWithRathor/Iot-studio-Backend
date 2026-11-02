import { Types } from 'mongoose';
import { mqttConfig } from '../../config/mqtt.config';
import { AVAILABILITY_TO_STATE, MQTT_LIMITS, type ConnectionState, type MessageKind, type MessageStatus } from '../../constants/mqtt.constants';
import { mqttMessageDao } from '../../dao/mqtt-message.dao';
import type { DeviceDoc } from '../../models/device.model';
import type { MqttMessageDoc } from '../../models/mqtt-message.model';
import type { CommandStateDTO, MqttMessageDTO, TransportMessage } from '../../types/mqtt.types';
import { addHours } from '../../utils/date.util';
import { BatchWriter, TelemetrySampler } from '../../utils/ingest-buffer.util';
import { channel } from '../../utils/logger.util';
import { ackTopicFor, classifyDeviceTopic, commandTopicForAck, decodeValue, numericSample, parseAck, topicMatches, validatePayload, type AckOutcome } from '../../utils/mqtt-topic.util';
import { summarisePayload } from '../../utils/redact.util';
import { activityService } from './activity.service';
import { deviceRegistry } from './device-registry.service';
import { mqttConnection } from './mqtt-connection.service';
import { realtimeService } from './realtime.service';
import { redisService } from './redis.service';

/**
 * Broker → backend → browser pipeline.
 *
 *   1. validate size / structure                 (invalid → dropped + logged)
 *   2. resolve the device from the topic prefix  (unknown/disabled → dropped)
 *   3. classify: availability | ack | telemetry   (inbound command echoes ignored)
 *   4. update state: connection state, last seen, latest value (Redis, coalesced), ack correlation
 *   5. persist to mqtt_messages (batched, TTL-limited). Telemetry is sampled:
 *      at most one document per topic per TELEMETRY_PERSIST_INTERVAL_MS, the
 *      newest value winning at the next flush (TelemetrySampler). Commands,
 *      acks and availability are always persisted. Retained telemetry (the
 *      broker replaying an old value) is never persisted.
 *   6. push an SSE event to the device OWNER's browser connections only
 *      (every message — live views are never sampled)
 *
 * Nothing here logs at info per message; one stats line every 60 s instead.
 */

type Doc = Omit<MqttMessageDoc, '_id'> & { _id: Types.ObjectId };

const log = () => channel('mqtt');
let flushTimer: NodeJS.Timeout | null = null;
let statsTimer: NodeJS.Timeout | null = null;
let unsubscribers: Array<() => Promise<void>> = [];
const customSubs = new Map<string, () => Promise<void>>();
let syncing: Promise<void> | null = null;
let syncAgain = false;
const dropped = { invalid: 0, unknownDevice: 0, lastLog: 0 };
const statWindow = { since: Date.now(), inbound: 0, written: 0 };
const loggedAt = { persist: 0, overflow: 0 };

function throttled(key: keyof typeof loggedAt, fn: () => void): void {
  const now = Date.now();
  if (now - loggedAt[key] < 30_000) return;
  loggedAt[key] = now;
  fn();
}

/** True when every write error is a duplicate key: a retried unordered insert whose documents the failed attempt already stored. */
function onlyDuplicateKeys(err: unknown): boolean {
  const e = err as { code?: number; writeErrors?: Array<{ code?: number; err?: { code?: number } }> };
  if (Array.isArray(e?.writeErrors) && e.writeErrors.length) return e.writeErrors.every((w) => (w.code ?? w.err?.code) === 11000);
  return e?.code === 11000;
}

const writer = new BatchWriter<Doc>({
  write: async (docs) => {
    try {
      await mqttMessageDao.insertMany(docs);
    } catch (err) {
      if (!onlyDuplicateKeys(err)) throw err;
    }
  },
  maxBuffered: MQTT_LIMITS.MESSAGE_BUFFER_MAX,
  chunkSize: MQTT_LIMITS.MESSAGE_FLUSH_CHUNK,
  maxAttempts: MQTT_LIMITS.MESSAGE_FLUSH_MAX_ATTEMPTS,
  onError: (err, info) =>
    throttled('persist', () => log().error('mqtt.persist.failed — batch kept for retry', { ...info, errorName: (err as Error)?.name, totals: { failed: writer.stats.failed, errors: writer.stats.errors } })),
  onOverflow: (n) => throttled('overflow', () => log().warn('mqtt.buffer.overflow — oldest messages dropped from persistence', { dropped: n, totalDropped: writer.stats.overflow })),
});

let sampler: TelemetrySampler<Doc> | null = null;
const samplerOf = () => (sampler ??= new TelemetrySampler<Doc>(mqttConfig().telemetryPersistIntervalMs));

interface PendingCommand {
  messageId: string;
  ownerId: string;
  deviceId: string;
  at: number;
  value: unknown;
  timer: NodeJS.Timeout;
}
const pending = new Map<string, PendingCommand>();
/** Last command state per command topic (for snapshots), bounded. */
const lastCommand = new Map<string, CommandStateDTO & { deviceId: string }>();

export function toMessageDTO(d: Pick<MqttMessageDoc, '_id' | 'at' | 'topic' | 'direction' | 'payload' | 'kind' | 'status' | 'deviceId' | 'simulated' | 'qos' | 'retain' | 'ackFor'>): MqttMessageDTO {
  const dto: MqttMessageDTO = {
    id: String(d._id),
    at: d.at.getTime(),
    topic: d.topic,
    direction: d.direction,
    payload: d.payload,
    kind: d.kind,
    status: d.status,
    deviceId: d.deviceId ? String(d.deviceId) : null,
    simulated: d.simulated,
    qos: d.qos,
    retain: d.retain || undefined,
  };
  if (d.ackFor) dto.ackFor = String(d.ackFor);
  return dto;
}

function buildDoc(input: { device: DeviceDoc | null; topic: string; payload: string; direction: 'in' | 'out'; kind: MessageKind; status: MessageStatus; qos: 0 | 1; retain: boolean; at: Date; num?: number | null; ackFor?: string | null; publishedBy?: string | null }) {
  return {
    _id: new Types.ObjectId(),
    ownerId: input.device ? input.device.ownerId : null,
    deviceId: input.device ? input.device._id : null,
    topic: input.topic,
    direction: input.direction,
    payload: input.payload,
    kind: input.kind,
    status: input.status,
    simulated: input.device?.simulated ?? false,
    qos: input.qos,
    retain: input.retain,
    num: input.num ?? null,
    ackFor: input.ackFor ? new Types.ObjectId(input.ackFor) : null,
    publishedBy: input.publishedBy ? new Types.ObjectId(input.publishedBy) : null,
    at: input.at,
    expireAt: addHours(input.at, mqttConfig().retentionHours),
  };
}

function enqueue(doc: Doc) {
  if (doc.kind !== 'telemetry') return writer.push(doc);
  if (!mqttConfig().persistTelemetry) return;
  const now = samplerOf().offer(doc.topic, doc); // a topic belongs to exactly one device
  if (now) writer.push(now);
}

/** Timer tick: release the telemetry samples that are due, then write. Never overlaps the previous write. */
function flushTick(): Promise<void> {
  for (const d of samplerOf().due(Date.now())) writer.push(d);
  return writer.flush();
}

/** Write everything queued by now (waits for a write in flight first). Held telemetry samples are released only when due. */
async function flush(): Promise<void> {
  for (const d of samplerOf().due(Date.now())) writer.push(d);
  await writer.flushNow();
}

function logStats(): void {
  const now = Date.now();
  const secs = Math.max(1, (now - statWindow.since) / 1000);
  const w = writer.stats;
  const latest = redisService.latestStats();
  const rt = realtimeService.stats();
  log().info('mqtt.ingest.stats', {
    msgsPerSec: Math.round((statWindow.inbound / secs) * 10) / 10,
    persistedPerSec: Math.round(((w.written - statWindow.written) / secs) * 10) / 10,
    buffered: writer.size,
    heldSamples: samplerOf().size,
    latestPending: latest.pending,
    dropsTotal: { invalid: dropped.invalid, unknownDevice: dropped.unknownDevice, bufferOverflow: w.overflow, persistFailed: w.failed, latest: latest.dropped, sseSkipped: rt.skipped },
    sseClients: rt.clients,
    devicesOnline: deviceRegistry.onlineCount(),
  });
  statWindow.since = now;
  statWindow.inbound = 0;
  statWindow.written = w.written;
}

function emitDevice(device: DeviceDoc) {
  const id = String(device._id);
  const runtime = deviceRegistry.runtimeOf(id);
  if (runtime) realtimeService.toDevice(id, { type: 'device', data: { deviceId: id, runtime } });
}

function noteDrop(kind: 'invalid' | 'unknownDevice', meta: Record<string, unknown>) {
  dropped[kind]++;
  const now = Date.now();
  if (now - dropped.lastLog > 30_000) {
    dropped.lastLog = now;
    log().warn('mqtt.inbound.dropped', { ...meta, totals: { invalid: dropped.invalid, unknownDevice: dropped.unknownDevice } });
  }
}

const STATE_ACTIVITY: Partial<Record<ConnectionState, { type: 'device.connected' | 'device.disconnected' | 'device.error'; text: string }>> = {
  connected: { type: 'device.connected', text: 'connected' },
  disconnected: { type: 'device.disconnected', text: 'disconnected — Last Will “offline” received' },
  error: { type: 'device.error', text: 'connection error' },
  auth_required: { type: 'device.error', text: 'broker rejected its credentials' },
};

function handleInbound(m: TransportMessage): void {
  statWindow.inbound++;
  const problem = validatePayload(m.payload, mqttConfig().maxPayloadBytes);
  if (problem) return noteDrop('invalid', { topic: m.topic, problem, payload: summarisePayload(m.payload, 60) });
  const device = deviceRegistry.resolveByTopic(m.topic);
  if (!device) return noteDrop('unknownDevice', { topic: m.topic });
  const deviceId = String(device._id);
  const ownerId = String(device.ownerId);
  const cls = classifyDeviceTopic(m.topic, device.topicPrefix);
  if (!cls || cls.kind === 'command') return; // our own command echoes in broker mode
  const at = new Date();
  const label = `${device.name}${device.simulated ? ' (simulated)' : ''}`;

  if (cls.kind === 'availability') {
    // Empty = a retained "online" being cleared (the backend's own clear after it cut a login off): not a report from the board.
    if (m.payload === '') return;
    let state: ConnectionState = 'waiting';
    try {
      state = AVAILABILITY_TO_STATE[(JSON.parse(m.payload) as { state?: string }).state ?? ''] ?? 'waiting';
    } catch {
      /* malformed availability → waiting */
    }
    deviceRegistry.markSeen(deviceId, at.getTime(), false, m.retain);
    const doc = buildDoc({ device, topic: m.topic, payload: m.payload, direction: 'in', kind: 'availability', status: 'received', qos: m.qos, retain: m.retain, at });
    enqueue(doc);
    realtimeService.toDevice(deviceId, { type: 'message', data: toMessageDTO(doc) });
    if (deviceRegistry.setState(deviceId, state, at.getTime())) {
      emitDevice(device);
      const a = STATE_ACTIVITY[state];
      if (a) void activityService.record({ ownerId, deviceId, type: a.type, message: `${label} ${a.text}` });
      log().debug('device.state', { deviceId, hardwareId: device.hardwareId, state, simulated: device.simulated });
    }
    return;
  }

  if (cls.kind === 'ack') {
    const commandTopic = commandTopicForAck(m.topic, device.topicPrefix);
    deviceRegistry.markSeen(deviceId, at.getTime(), false);
    const ackFor = commandTopic ? resolveAck(commandTopic, at.getTime(), parseAck(m.payload)) : null;
    const doc = buildDoc({ device, topic: m.topic, payload: m.payload, direction: 'in', kind: 'ack', status: 'received', qos: m.qos, retain: false, at, ackFor });
    enqueue(doc);
    realtimeService.toDevice(deviceId, { type: 'message', data: toMessageDTO(doc) });
    return;
  }

  // telemetry / reported state (also custom state topics under the prefix)
  const value = decodeValue(m.payload);
  redisService.queueLatest(deviceId, m.topic, value, at.getTime());
  const doc = buildDoc({ device, topic: m.topic, payload: m.payload, direction: 'in', kind: 'telemetry', status: 'received', qos: m.qos, retain: m.retain, at, num: numericSample(value) });
  if (m.retain) {
    // The broker replaying an old value (our reconnect, a new subscription): latest value + live views only —
    // not a fresh history sample, not a sign of life, not the device's "first telemetry".
    deviceRegistry.markSeen(deviceId, at.getTime(), true, true);
    realtimeService.toDevice(deviceId, { type: 'message', data: toMessageDTO(doc) });
    return;
  }
  const { first } = deviceRegistry.markSeen(deviceId, at.getTime(), true);
  const runtime = deviceRegistry.runtimeOf(deviceId);
  if (runtime && (runtime.state === 'waiting' || runtime.state === 'disconnected')) {
    deviceRegistry.setState(deviceId, 'connected', at.getTime());
    emitDevice(device);
  }
  enqueue(doc);
  realtimeService.toDevice(deviceId, { type: 'message', data: toMessageDTO(doc) });
  if (first) void activityService.record({ ownerId, deviceId, type: 'telemetry.first', message: `First telemetry from ${label} on ${m.topic}` });
}

/** Settle the pending command for this topic: acknowledged, or failed when the device answered `"ok": false`. */
function resolveAck(commandTopic: string, at: number, outcome: AckOutcome): string | null {
  const p = pending.get(commandTopic);
  if (!p) {
    void redisService.takePending(commandTopic).catch(() => null);
    return null;
  }
  clearTimeout(p.timer);
  pending.delete(commandTopic);
  void redisService.takePending(commandTopic).catch(() => null);
  const state: CommandStateDTO = outcome.ok
    ? { status: 'acknowledged', at: p.at, ackAt: at, value: p.value, messageId: p.messageId }
    : { status: 'failed', at: p.at, ackAt: at, value: p.value, messageId: p.messageId, reason: `Device: ${outcome.error}` };
  lastCommand.set(commandTopic, { ...state, deviceId: p.deviceId });
  void mqttMessageDao.setStatus(p.messageId, outcome.ok ? 'acknowledged' : 'failed').catch(() => undefined);
  realtimeService.toDevice(p.deviceId, { type: 'command', data: { topic: commandTopic, command: state } });
  if (!outcome.ok) void activityService.record({ ownerId: p.ownerId, deviceId: p.deviceId, type: 'command.failed', message: `${commandTopic.split('/').pop()}: rejected by the device — ${outcome.error}` });
  return p.messageId;
}

/** Explicit, scoped subscriptions — never '#'. */
const rootFilters = (root: string) => [`${root}/+/telemetry/+`, `${root}/+/ack/+`, `${root}/+/availability`];

async function syncCustomSubscriptionsOnce(): Promise<void> {
  const root = mqttConfig().topicRoot;
  const filters = rootFilters(root);
  const covered = (topic: string) => filters.some((f) => topicMatches(f, topic));
  const wanted = new Set<string>();
  for (const d of deviceRegistry.all()) {
    if (!d.topicPrefix.startsWith(`${root}/`) || d.topicPrefix.split('/').length !== root.split('/').length + 1) {
      wanted.add(`${d.topicPrefix}/#`);
      continue;
    }
    for (const v of deviceRegistry.variablesOf(String(d._id))) {
      if (v.stateTopic && !covered(v.stateTopic)) wanted.add(v.stateTopic);
      // A conventional command topic is acked on {prefix}/ack/{key} — already covered by {root}/+/ack/+.
      // Only custom command topics (acked on <commandTopic>/ack) need their own subscription.
      if (v.commandTopic) {
        const ack = ackTopicFor(v.commandTopic, d.topicPrefix);
        if (!covered(ack)) wanted.add(ack);
      }
    }
  }
  for (const f of wanted) if (!customSubs.has(f)) customSubs.set(f, await mqttConnection.subscribe(f, handleInbound));
  for (const [f, unsub] of customSubs) if (!wanted.has(f)) {
    customSubs.delete(f);
    await unsub();
  }
}

export const mqttIngestService = {
  async start(): Promise<void> {
    sampler = new TelemetrySampler<Doc>(mqttConfig().telemetryPersistIntervalMs);
    const filters = rootFilters(mqttConfig().topicRoot);
    for (const f of filters) unsubscribers.push(await mqttConnection.subscribe(f, handleInbound));
    await mqttIngestService.syncCustomSubscriptions();
    deviceRegistry.onChange(() => {
      mqttIngestService.syncCustomSubscriptions().catch((err) => log().error('mqtt.subscriptions.sync_failed', { errorName: (err as Error).name, error: (err as Error).message }));
    });
    flushTimer = setInterval(() => void flushTick().catch(() => undefined), MQTT_LIMITS.MESSAGE_FLUSH_INTERVAL_MS);
    flushTimer.unref();
    statWindow.since = Date.now();
    statWindow.inbound = 0;
    statWindow.written = writer.stats.written;
    statsTimer = setInterval(logStats, MQTT_LIMITS.INGEST_STATS_INTERVAL_MS);
    statsTimer.unref();
    log().info('mqtt.ingest.started', { filters, telemetryPersistIntervalMs: samplerOf().intervalMs });
  },

  /**
   * Devices whose prefix is outside the default root, or variables with custom state/command topics, get exact
   * subscriptions. Serialized: a change arriving during a sync runs one more sync after it.
   */
  syncCustomSubscriptions(): Promise<void> {
    if (syncing) {
      syncAgain = true;
      return syncing;
    }
    syncing = (async () => {
      do {
        syncAgain = false;
        await syncCustomSubscriptionsOnce();
      } while (syncAgain);
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  },

  async stop(): Promise<void> {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    if (syncing) await syncing.catch(() => undefined);
    for (const d of samplerOf().drain()) writer.push(d);
    await writer.flushNow();
    for (const u of [...unsubscribers, ...customSubs.values()]) await u().catch(() => undefined);
    unsubscribers = [];
    customSubs.clear();
  },

  /** Persist an outgoing message immediately (commands need their id before the ack can arrive). */
  async recordOutgoing(input: { device: DeviceDoc; topic: string; payload: string; status: MessageStatus; kind?: MessageKind; publishedBy: string; qos: 0 | 1 }): Promise<MqttMessageDTO> {
    const doc = buildDoc({ device: input.device, topic: input.topic, payload: input.payload, direction: 'out', kind: input.kind ?? 'command', status: input.status, qos: input.qos, retain: false, at: new Date(), publishedBy: input.publishedBy });
    await mqttMessageDao.insertMany([doc]);
    const dto = toMessageDTO(doc);
    realtimeService.toDevice(String(input.device._id), { type: 'message', data: dto });
    return dto;
  },

  /** Start waiting for the device's acknowledgement. Times out → status failed. */
  trackCommand(input: { topic: string; messageId: string; ownerId: string; deviceId: string; value: unknown; at: number; failureReason: string }): CommandStateDTO {
    const prev = pending.get(input.topic);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      const p = pending.get(input.topic);
      if (!p || p.messageId !== input.messageId) return;
      pending.delete(input.topic);
      const failed: CommandStateDTO = { status: 'failed', at: p.at, value: p.value, messageId: p.messageId, reason: input.failureReason };
      lastCommand.set(input.topic, { ...failed, deviceId: p.deviceId });
      void mqttMessageDao.setStatus(p.messageId, 'failed').catch(() => undefined);
      realtimeService.toDevice(p.deviceId, { type: 'command', data: { topic: input.topic, command: failed } });
      void activityService.record({ ownerId: p.ownerId, deviceId: p.deviceId, type: 'command.failed', message: `${input.topic.split('/').pop()}: ${input.failureReason}` });
    }, MQTT_LIMITS.ACK_TIMEOUT_MS);
    timer.unref();
    pending.set(input.topic, { messageId: input.messageId, ownerId: input.ownerId, deviceId: input.deviceId, at: input.at, value: input.value, timer });
    void redisService.setPending(input.topic, { messageId: input.messageId, ownerId: input.ownerId, at: input.at }, MQTT_LIMITS.PENDING_COMMAND_TTL_S).catch(() => undefined);
    const state: CommandStateDTO = { status: 'pending', at: input.at, value: input.value, messageId: input.messageId };
    lastCommand.set(input.topic, { ...state, deviceId: input.deviceId });
    if (lastCommand.size > 2000) lastCommand.delete(lastCommand.keys().next().value as string);
    return state;
  },

  /** Recent command states for the given devices (snapshot). */
  commandsFor(deviceIds: Set<string>): Record<string, CommandStateDTO> {
    const out: Record<string, CommandStateDTO> = {};
    for (const [topic, c] of lastCommand) {
      if (!deviceIds.has(c.deviceId)) continue;
      const { deviceId: _d, ...state } = c;
      out[topic] = state;
    }
    return out;
  },

  /** Seed historical samples for simulated devices (charts are not empty on first run). Not broadcast, not sampled. */
  queueHistorical(device: DeviceDoc, topic: string, value: unknown, at: Date): void {
    if (!mqttConfig().persistTelemetry) return;
    writer.push(buildDoc({ device, topic, payload: JSON.stringify({ value }), direction: 'in', kind: 'telemetry', status: 'received', qos: 0, retain: false, at, num: numericSample(value) }));
  },

  flush,
  handleInbound,
  /** Write-path counters (tests, admin status). */
  stats: () => ({ buffered: writer.size, heldSamples: samplerOf().size, ...writer.stats, dropped: { invalid: dropped.invalid, unknownDevice: dropped.unknownDevice } }),
};

