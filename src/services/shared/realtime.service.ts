import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { MQTT_LIMITS } from '../../constants/mqtt.constants';
import type { RealtimeEvent } from '../../types/mqtt.types';
import { channel } from '../../utils/logger.util';

/**
 * Server-Sent Events hub. Every browser connection is registered with the
 * set of device ids its user OWNS (resolved from the database at connect
 * time and refreshed whenever ownership changes). Device events are only
 * written to connections whose set contains the device, so one user's
 * telemetry can never reach another user's browser.
 *
 * Connections are indexed by device and by user, so a message touches only
 * its viewers. Backpressure: when res.write() returns false the socket is
 * congested — until 'drain', skippable frames (the console 'message' feed,
 * pings) are dropped for that connection while state events still go out;
 * a connection that stays congested for SSE_STUCK_MS, or buffers more than
 * SSE_MAX_BUFFERED_BYTES, is closed (the browser reconnects and reloads).
 */
interface Client {
  id: string;
  userId: string;
  sessionId: string;
  res: Response;
  deviceIds: Set<string>;
  closeTimer: NodeJS.Timeout | null;
  /** When write() last returned false without a 'drain' since; null = writable. */
  blockedSince: number | null;
}

const clients = new Map<string, Client>();
const byDevice = new Map<string, Set<Client>>();
const byUser = new Map<string, Set<Client>>();
const counters = { skipped: 0, closedStuck: 0 };
let heartbeat: NodeJS.Timeout | null = null;
const log = () => channel('mqtt');

/** Frames a congested connection may lose: the console feed and heartbeats. Device/command/activity/status events are never skipped. */
const SKIPPABLE = new Set(['message', 'ping']);

const frame = (ev: RealtimeEvent | { type: string; data: unknown }) => `event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`;

function addTo(map: Map<string, Set<Client>>, key: string, c: Client): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(c);
}

function removeFrom(map: Map<string, Set<Client>>, key: string, c: Client): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(c);
  if (!set.size) map.delete(key);
}

function deliver(c: Client, type: string, data: string): void {
  if (c.blockedSince !== null) {
    if (Date.now() - c.blockedSince > MQTT_LIMITS.SSE_STUCK_MS) return closeStuck(c);
    if (SKIPPABLE.has(type)) {
      counters.skipped++;
      return;
    }
  }
  try {
    if (c.res.write(data)) return;
    if (c.res.writableLength > MQTT_LIMITS.SSE_MAX_BUFFERED_BYTES) return closeStuck(c);
    if (c.blockedSince === null) {
      c.blockedSince = Date.now();
      c.res.once('drain', () => {
        c.blockedSince = null;
      });
    }
  } catch {
    remove(c.id);
  }
}

function closeStuck(c: Client): void {
  counters.closedStuck++;
  log().debug('sse.closed_stuck', { userId: c.userId, buffered: c.res.writableLength });
  remove(c.id);
}

function remove(id: string): void {
  const c = clients.get(id);
  if (!c) return;
  clients.delete(id);
  removeFrom(byUser, c.userId, c);
  for (const d of c.deviceIds) removeFrom(byDevice, d, c);
  if (c.closeTimer) clearTimeout(c.closeTimer);
  try {
    c.res.end();
  } catch {
    /* already closed */
  }
}

function ensureHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    // also where a congested-and-silent connection is noticed and closed
    for (const c of Array.from(clients.values())) deliver(c, 'ping', `: ping ${Date.now()}\n\n`);
  }, MQTT_LIMITS.SSE_HEARTBEAT_MS);
  heartbeat.unref();
}

export const realtimeService = {
  /**
   * Register an SSE response. `endAt` (epoch ms) closes the stream when the
   * access token expires — the browser refreshes its session and reconnects.
   */
  register(input: { userId: string; sessionId: string; res: Response; deviceIds: string[]; endAt: number }): () => void {
    const mine = byUser.get(input.userId);
    if (mine && mine.size >= MQTT_LIMITS.SSE_MAX_CONNECTIONS_PER_USER) remove(mine.values().next().value!.id); // drop the oldest
    const c: Client = { id: randomUUID(), userId: input.userId, sessionId: input.sessionId, res: input.res, deviceIds: new Set(input.deviceIds), closeTimer: null, blockedSince: null };
    const ms = Math.max(5_000, input.endAt - Date.now());
    c.closeTimer = setTimeout(() => {
      deliver(c, 'reauth', frame({ type: 'reauth', data: { reason: 'access_token_expiring' } }));
      remove(c.id);
    }, ms);
    clients.set(c.id, c);
    addTo(byUser, c.userId, c);
    for (const d of c.deviceIds) addTo(byDevice, d, c);
    ensureHeartbeat();
    log().debug('sse.open', { userId: input.userId, connections: clients.size });
    return () => {
      remove(c.id);
      log().debug('sse.close', { userId: input.userId, connections: clients.size });
    };
  },

  send(res: Response, ev: RealtimeEvent): void {
    res.write(frame(ev));
  },

  /** The stream's `retry:` hint, with jitter so a server restart does not bring every browser back in the same second. */
  retryFrame: () => `retry: ${MQTT_LIMITS.SSE_RETRY_MS + Math.floor(Math.random() * MQTT_LIMITS.SSE_RETRY_JITTER_MS)}\n\n`,

  /** Deliver a device-scoped event to every connection that owns the device. Serialized once. */
  toDevice(deviceId: string, ev: RealtimeEvent): void {
    const set = byDevice.get(deviceId);
    if (!set?.size) return;
    const data = frame(ev);
    for (const c of Array.from(set)) deliver(c, ev.type, data);
  },

  toUser(userId: string, ev: RealtimeEvent): void {
    const set = byUser.get(userId);
    if (!set?.size) return;
    const data = frame(ev);
    for (const c of Array.from(set)) deliver(c, ev.type, data);
  },

  /** Non-sensitive, global events only (e.g. simulation paused). */
  broadcast(ev: RealtimeEvent): void {
    const data = frame(ev);
    for (const c of Array.from(clients.values())) deliver(c, ev.type, data);
  },

  /** Ownership changed: update which devices a user's open streams may receive. */
  setUserDevices(userId: string, deviceIds: string[]): void {
    for (const c of byUser.get(userId) ?? []) {
      for (const d of c.deviceIds) removeFrom(byDevice, d, c);
      c.deviceIds = new Set(deviceIds);
      for (const d of c.deviceIds) addTo(byDevice, d, c);
    }
  },

  closeSession(sessionId: string): void {
    for (const c of Array.from(clients.values())) if (c.sessionId === sessionId) remove(c.id);
  },

  closeUser(userId: string): void {
    for (const c of Array.from(byUser.get(userId) ?? [])) remove(c.id);
  },

  closeAll(): void {
    for (const id of Array.from(clients.keys())) remove(id);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  },

  count: () => clients.size,
  stats: () => ({ clients: clients.size, ...counters }),
};
