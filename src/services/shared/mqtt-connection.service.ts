import mqtt, { type MqttClient } from 'mqtt';
import { mqttConfig } from '../../config/mqtt.config';
import type { ConnectionState } from '../../constants/mqtt.constants';
import type { TransportMessage } from '../../types/mqtt.types';
import { channel } from '../../utils/logger.util';
import { redactString } from '../../utils/redact.util';
import { FilterIndex, chunkSubscribeFilters, topicMatches } from '../../utils/mqtt-topic.util';

/**
 * The backend's ONE MQTT connection, shared by the ingestion pipeline and
 * the demo simulator.
 *
 *   MQTT_MODE=simulated → LoopbackTransport: an in-process broker. Nothing
 *                         leaves the server; only simulated devices exist.
 *   MQTT_MODE=broker    → BrokerTransport: MQTT.js client to a real broker
 *                         (Mosquitto in docker-compose, or EMQX/HiveMQ),
 *                         with credentials that never leave the server.
 *
 * Consumers subscribe with explicit filters; the transport subscribes each
 * filter once and fans messages out to the matching handlers (exact filters
 * by Map lookup, wildcard filters by level match — see FilterIndex).
 */

type Handler = (m: TransportMessage) => void;

interface Transport {
  readonly label: string;
  connect(): Promise<void>;
  close(): Promise<void>;
  subscribe(filter: string): Promise<void>;
  unsubscribe(filter: string): Promise<void>;
  publish(topic: string, payload: string, opts: { qos: 0 | 1; retain: boolean }): Promise<void>;
}

const log = () => channel('mqtt');
const handlers = new FilterIndex<Handler>();
const stateListeners = new Set<(s: ConnectionState) => void>();
let state: ConnectionState = 'disconnected';
let transport: Transport | null = null;

function setState(s: ConnectionState) {
  if (state === s) return;
  state = s;
  log().info('mqtt.state', { state: s });
  stateListeners.forEach((l) => l(s));
}

function dispatch(m: TransportMessage) {
  handlers.forEachMatch(m.topic, (filter, set) => {
    for (const h of set) {
      try {
        h(m);
      } catch (err) {
        log().error('mqtt.handler.failed', { filter, errorName: (err as Error).name, error: (err as Error).message });
      }
    }
  });
}

class LoopbackTransport implements Transport {
  readonly label = 'In-process simulated broker (no network)';
  private retained = new Map<string, TransportMessage>();
  private filters = new Set<string>();
  async connect() {
    setState('connected');
  }
  async close() {
    setState('disconnected');
  }
  async subscribe(filter: string) {
    this.filters.add(filter);
    for (const m of this.retained.values()) if (topicMatches(filter, m.topic)) setImmediate(() => dispatch(m));
  }
  async unsubscribe(filter: string) {
    this.filters.delete(filter);
  }
  async publish(topic: string, payload: string, opts: { qos: 0 | 1; retain: boolean }) {
    const m: TransportMessage = { topic, payload, qos: opts.qos, retain: false };
    if (opts.retain) this.retained.set(topic, { ...m, retain: true });
    setImmediate(() => dispatch(m));
  }
}

/**
 * Sends every filter again after a (re)connect, split into SUBSCRIBE packets
 * of at most MQTT_LIMITS.SUBSCRIBE_PACKET_MAX_BYTES. One packet with every
 * filter would pass the broker's max_packet_size once there are a few hundred
 * devices/custom topics, and Mosquitto answers that by dropping the
 * connection, on every reconnect, forever.
 */
export function resubscribeAll(
  client: { subscribe(filters: string[], opts: { qos: 1 }, cb: (err: Error | null) => void): unknown },
  filters: readonly string[],
): void {
  for (const chunk of chunkSubscribeFilters(filters)) {
    client.subscribe(chunk, { qos: 1 }, (err) => err && log().error('mqtt.resubscribe.failed', { filters: chunk.length, error: err.message }));
  }
}

class BrokerTransport implements Transport {
  readonly label: string;
  private client: MqttClient | null = null;
  constructor(private url: string) {
    this.label = `MQTT broker ${redactString(url)}`;
  }
  connect(): Promise<void> {
    const cfg = mqttConfig();
    setState('connecting');
    return new Promise((resolve, reject) => {
      const client = mqtt.connect(this.url, {
        clientId: cfg.clientId,
        username: cfg.username,
        password: cfg.password,
        clean: true,
        reconnectPeriod: cfg.reconnectPeriodMs,
        connectTimeout: cfg.connectTimeoutMs,
        keepalive: 30,
        protocolVersion: 4,
        // We resubscribe every filter ourselves on 'connect' (below), including filters added while offline;
        // MQTT.js's own resubscribe would send each SUBSCRIBE (and get each retained message) a second time.
        resubscribe: false,
      });
      this.client = client;
      let settled = false;
      client.on('connect', () => {
        setState('connected');
        // re-subscribe after reconnects (clean session)
        resubscribeAll(client, handlers.filters());
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      client.on('reconnect', () => setState('connecting'));
      client.on('offline', () => setState('disconnected'));
      client.on('close', () => state !== 'disconnected' && setState('connecting'));
      client.on('error', (err) => {
        const auth = /not authorized|bad user name or password/i.test(err.message);
        setState(auth ? 'auth_required' : 'error');
        log().error('mqtt.error', { error: redactString(err.message) });
        if (!settled && auth) {
          settled = true;
          reject(new Error('The MQTT broker rejected the backend credentials (MQTT_USERNAME / MQTT_PASSWORD).'));
        }
      });
      client.on('message', (topic, buf, packet) => dispatch({ topic, payload: buf.toString('utf8'), qos: packet.qos === 0 ? 0 : 1, retain: packet.retain }));
      setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Could not reach the MQTT broker at ${redactString(this.url)} within ${cfg.connectTimeoutMs} ms. Is it running?`));
        }
      }, cfg.connectTimeoutMs + 500).unref();
    });
  }
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.client) return resolve();
      this.client.end(false, {}, () => {
        setState('disconnected');
        resolve();
      });
    });
  }
  subscribe(filter: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client?.connected) return resolve(); // resubscribed on connect
      this.client.subscribe(filter, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
  }
  unsubscribe(filter: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.client?.connected) return resolve();
      this.client.unsubscribe(filter, () => resolve());
    });
  }
  publish(topic: string, payload: string, opts: { qos: 0 | 1; retain: boolean }): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client?.connected) return reject(new Error('MQTT broker not connected'));
      this.client.publish(topic, payload, { qos: opts.qos, retain: opts.retain }, (err) => (err ? reject(err) : resolve()));
    });
  }
}

export const mqttConnection = {
  async connect(): Promise<void> {
    const cfg = mqttConfig();
    transport = cfg.mode === 'broker' ? new BrokerTransport(cfg.brokerUrl!) : new LoopbackTransport();
    log().info('mqtt.connecting', { mode: cfg.mode, transport: transport.label });
    await transport.connect();
  },

  async close(): Promise<void> {
    await transport?.close();
    handlers.clear();
  },

  mode: () => mqttConfig().mode,
  label: () => transport?.label ?? 'not started',
  state: () => state,
  isConnected: () => state === 'connected',

  onState(cb: (s: ConnectionState) => void): () => void {
    stateListeners.add(cb);
    return () => stateListeners.delete(cb);
  },

  /** Subscribe a handler to a filter. Returns an unsubscribe function. */
  async subscribe(filter: string, handler: Handler): Promise<() => Promise<void>> {
    if (handlers.add(filter, handler)) {
      await transport?.subscribe(filter);
      log().debug('mqtt.subscribed', { filter });
    }
    return async () => {
      if (handlers.remove(filter, handler)) await transport?.unsubscribe(filter);
    };
  },

  async publish(topic: string, payload: string, opts: { qos?: 0 | 1; retain?: boolean } = {}): Promise<void> {
    if (!transport || state !== 'connected') throw new Error('MQTT transport not connected');
    await transport.publish(topic, payload, { qos: opts.qos ?? 0, retain: opts.retain ?? false });
  },

  subscribedFilters: () => handlers.filters(),
};
