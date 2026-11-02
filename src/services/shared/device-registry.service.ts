import { MQTT_LIMITS, type ConnectionState, type SimMode } from '../../constants/mqtt.constants';
import { deviceDao } from '../../dao/device.dao';
import { variableDao } from '../../dao/variable.dao';
import type { DeviceDoc } from '../../models/device.model';
import type { VariableDoc } from '../../models/variable.model';
import type { DeviceRuntimeDTO } from '../../types/mqtt.types';
import { channel } from '../../utils/logger.util';
import { PrefixIndex } from '../../utils/mqtt-topic.util';

/**
 * In-memory routing table + live connection state for every ACTIVE device.
 *   - resolves an incoming topic to its device by the device's topic prefix
 *     (longest prefix wins, O(topic levels) — see PrefixIndex); topics outside
 *     every prefix are dropped
 *   - holds the runtime state the frontend shows (connected, last seen, …)
 *   - persists connection-state changes immediately and last-seen at most
 *     every 30 s per device (write throttling)
 * Rebuilt from MongoDB on start and on refresh()/invalidate(); one device at
 * a time with upsertDevice()/reloadDevice()/removeDevice().
 */

interface RuntimeEntry extends DeviceRuntimeDTO {
  lastSeenPersistedAt: number;
}

let devices = new Map<string, DeviceDoc>();
let prefixIndex = new PrefixIndex();
let variablesByDevice = new Map<string, VariableDoc[]>();
const runtime = new Map<string, RuntimeEntry>();
const simModes = new Map<string, SimMode>();
const listeners = new Set<() => void>();
let refreshTimer: NodeJS.Timeout | null = null;
let loading: Promise<void> | null = null;
let reloadAfter: Promise<void> | null = null;

const log = () => channel('mqtt');

function initRuntime(d: DeviceDoc): RuntimeEntry {
  return {
    state: d.connectionState ?? (d.simulated ? 'connecting' : 'waiting'),
    lastSeen: d.lastSeenAt ? d.lastSeenAt.getTime() : null,
    since: d.connectionSince ? d.connectionSince.getTime() : Date.now(),
    messageCount: 0,
    telemetrySeen: Boolean(d.lastSeenAt),
    lastSeenPersistedAt: d.lastSeenAt ? d.lastSeenAt.getTime() : 0,
  };
}

async function load(): Promise<void> {
  const list = await deviceDao.listActive();
  const vars = list.length ? await variableDao.listByDevices(list.map((d) => String(d._id))) : [];
  const next = new Map(list.map((d) => [String(d._id), d]));
  const byDev = new Map<string, VariableDoc[]>();
  for (const v of vars) {
    const k = String(v.deviceId);
    byDev.set(k, [...(byDev.get(k) ?? []), v]);
  }
  for (const [id, d] of next) if (!runtime.has(id)) runtime.set(id, initRuntime(d));
  for (const id of Array.from(runtime.keys())) if (!next.has(id)) runtime.delete(id);
  const prefixes = new PrefixIndex();
  for (const d of list) prefixes.set(d.topicPrefix, String(d._id));
  devices = next;
  variablesByDevice = byDev;
  prefixIndex = prefixes;
  log().debug('registry.refreshed', { devices: devices.size, variables: vars.length });
  listeners.forEach((l) => l());
}

/** After a one-device change: a full load still running may have read the database before it, so queue one more. */
function changed(): void {
  if (loading) deviceRegistry.refresh().catch((err) => log().error('registry.refresh.failed', { errorName: (err as Error).name }));
  listeners.forEach((l) => l());
}

export const deviceRegistry = {
  /**
   * Full reload, coalesced: concurrent callers share one load. A caller
   * arriving while a load runs gets ONE follow-up load (shared by everyone
   * who arrives meanwhile), because the running load may have read the
   * database before that caller's write.
   */
  refresh(): Promise<void> {
    if (!loading) {
      loading = load().finally(() => {
        loading = null;
      });
      return loading;
    }
    reloadAfter ??= loading
      .catch(() => undefined)
      .then(() => {
        reloadAfter = null;
        return deviceRegistry.refresh();
      });
    return reloadAfter;
  },

  /** Incremental update of ONE device (and its variables, when given). A device that is no longer active is removed. */
  upsertDevice(d: DeviceDoc, variables?: VariableDoc[]): void {
    const id = String(d._id);
    if (d.status !== 'active') return deviceRegistry.removeDevice(id);
    const prev = devices.get(id);
    if (prev && prev.topicPrefix !== d.topicPrefix) prefixIndex.delete(prev.topicPrefix, id);
    devices.set(id, d);
    prefixIndex.set(d.topicPrefix, id);
    if (variables) variablesByDevice.set(id, variables);
    if (!runtime.has(id)) runtime.set(id, initRuntime(d));
    changed();
  },

  removeDevice(id: string): void {
    const prev = devices.get(id);
    if (prev) prefixIndex.delete(prev.topicPrefix, id);
    devices.delete(id);
    variablesByDevice.delete(id);
    runtime.delete(id);
    changed();
  },

  /** Re-read ONE device and its variables from MongoDB (device CRUD, LMS upsert) instead of reloading every device. */
  async reloadDevice(id: string): Promise<void> {
    const d = await deviceDao.findById(id);
    if (!d || d.status !== 'active') return deviceRegistry.removeDevice(id);
    deviceRegistry.upsertDevice(d, await variableDao.listByDevices([id]));
  },

  /** Debounced refresh after a device/variable change. */
  invalidate(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      deviceRegistry.refresh().catch((err) => log().error('registry.refresh.failed', { errorName: (err as Error).name }));
    }, 150);
    refreshTimer.unref();
  },

  onChange(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },

  get: (id: string) => devices.get(id) ?? null,
  all: () => Array.from(devices.values()),
  simulatedDevices: () => Array.from(devices.values()).filter((d) => d.simulated),
  variablesOf: (deviceId: string) => variablesByDevice.get(deviceId) ?? [],

  /** Longest-prefix match. Null when the topic is not inside any registered device namespace. */
  resolveByTopic(topic: string): DeviceDoc | null {
    const id = prefixIndex.resolve(topic);
    return id ? (devices.get(id) ?? null) : null;
  },

  ownedDeviceIds: (ownerId: string) => Array.from(devices.values()).filter((d) => String(d.ownerId) === ownerId).map((d) => String(d._id)),

  runtimeOf(id: string): DeviceRuntimeDTO | null {
    const r = runtime.get(id);
    if (!r) return null;
    const { lastSeenPersistedAt: _x, ...dto } = r;
    const d = devices.get(id);
    return d?.simulated ? { ...dto, simMode: simModes.get(id) ?? 'online' } : dto;
  },

  /** Returns true when the state actually changed. */
  setState(id: string, state: ConnectionState, at = Date.now()): boolean {
    const r = runtime.get(id);
    if (!r || r.state === state) return false;
    r.state = state;
    r.since = at;
    deviceDao.setConnection(id, state, new Date(at)).catch(() => undefined);
    return true;
  },

  /** Devices currently in state "connected" (stats). */
  onlineCount(): number {
    let n = 0;
    for (const r of runtime.values()) if (r.state === 'connected') n++;
    return n;
  },

  /**
   * Record that a message arrived. Returns { first } when this is the device's first telemetry ever.
   * A RETAINED message is the broker replaying an old one (e.g. after our reconnect): it proves the
   * device sent telemetry once, but not that it is alive now — no last-seen, no "first".
   */
  markSeen(id: string, at: number, telemetry: boolean, retained = false): { first: boolean } {
    const r = runtime.get(id);
    if (!r) return { first: false };
    if (retained) {
      if (telemetry) r.telemetrySeen = true;
      return { first: false };
    }
    r.lastSeen = Math.max(r.lastSeen ?? 0, at);
    r.messageCount++;
    let first = false;
    if (telemetry && !r.telemetrySeen) {
      r.telemetrySeen = true;
      first = true;
    }
    if (at - r.lastSeenPersistedAt >= MQTT_LIMITS.LAST_SEEN_PERSIST_INTERVAL_MS) {
      r.lastSeenPersistedAt = at;
      deviceDao.touchLastSeen(id, new Date(at)).catch(() => undefined);
    }
    return { first };
  },

  simMode: (id: string): SimMode => simModes.get(id) ?? 'online',
  setSimMode: (id: string, m: SimMode) => simModes.set(id, m),

  stop(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
  },
};
