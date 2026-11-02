import { mqttConfig } from '../../config/mqtt.config';
import type { DataType } from '../../constants/app.constants';
import type { SimMode } from '../../constants/mqtt.constants';
import { mqttMessageDao } from '../../dao/mqtt-message.dao';
import type { DeviceDoc } from '../../models/device.model';
import type { TransportMessage } from '../../types/mqtt.types';
import { channel } from '../../utils/logger.util';
import { ackTopicFor, coerceCommandValue, conventionalTopics, decodeValue, encodeValue } from '../../utils/mqtt-topic.util';
import { deviceRegistry } from './device-registry.service';
import { mqttIngestService } from './mqtt-ingest.service';
import { mqttConnection } from './mqtt-connection.service';

/**
 * SERVER-SIDE demo simulator. It plays the role of the ESP32s marked
 * `simulated: true`: it publishes availability, telemetry and acks through
 * the same MQTT connection real devices use, so the browser receives demo
 * data through exactly the production path (MQTT → pipeline → SSE).
 * Everything it produces is labelled simulated in the DB, the API and logs.
 */

interface Channel {
  device: DeviceDoc;
  key: string;
  dataType: DataType;
  stateful: boolean;
  stateTopic?: string;
  commandTopic?: string;
  unit?: string;
  min?: number;
  max?: number;
}

const log = () => channel('mqtt');
const ACTUATOR_DEFAULTS: Record<string, unknown> = { led_state: false, pump_state: false, motor_speed: 0, rgb_color: '#6262f5', brightness: 70, buzzer: false };
const values = new Map<string, unknown>();
const announced = new Map<string, string>();
const timers = new Set<NodeJS.Timeout>();
let tickTimer: NodeJS.Timeout | null = null;
let tickCount = 0;
let paused = false;
let intervalMs = 2000;
let enabled = false;
let unsubs: Array<() => Promise<void>> = [];
const commandSubs = new Map<string, () => Promise<void>>();

function later(fn: () => void, ms: number) {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
}

const pub = (topic: string, payload: string, retain = false) =>
  mqttConnection.publish(topic, payload, { qos: 0, retain }).catch((err) => log().warn('sim.publish.failed', { topic, error: (err as Error).message }));

function channelsOf(d: DeviceDoc): Channel[] {
  const map = new Map<string, Channel>();
  for (const c of d.capabilities) {
    const t = conventionalTopics(d.topicPrefix, c.key);
    map.set(c.key, {
      device: d, key: c.key, dataType: c.dataType, stateful: c.direction !== 'telemetry',
      stateTopic: c.direction !== 'command' ? t.telemetry : undefined, commandTopic: c.direction !== 'telemetry' ? t.command : undefined,
      unit: c.unit, min: c.min, max: c.max,
    });
  }
  // Variables with custom topics on a simulated device are simulated too.
  for (const v of deviceRegistry.variablesOf(String(d._id))) {
    const conv = map.get(v.key);
    if (conv && conv.stateTopic === v.stateTopic && (!v.commandTopic || conv.commandTopic === v.commandTopic)) continue;
    map.set(`var:${v._id}`, {
      device: d, key: v.key, dataType: v.dataType, stateful: v.direction !== 'telemetry',
      stateTopic: v.stateTopic, commandTopic: v.commandTopic, unit: v.unit, min: v.min, max: v.max,
    });
  }
  return Array.from(map.values());
}

const vkey = (c: Channel) => `${c.device._id}:${c.stateTopic ?? c.commandTopic ?? c.key}`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function initial(c: Channel): unknown {
  const fixed: Record<string, unknown> = { temperature: 26.4, humidity: 58, soil_moisture: 62, battery: 87, pressure: 1012.6, light_level: 540, wind_speed: 9, status_text: 'OK · all sensors nominal', uptime: 3600 + Math.floor(Math.random() * 7200) };
  if (c.stateful && c.key in ACTUATOR_DEFAULTS) return ACTUATOR_DEFAULTS[c.key];
  if (c.key in fixed) return fixed[c.key];
  const lo = c.min ?? 0;
  const hi = c.max ?? 100;
  switch (c.dataType) {
    case 'boolean': return false;
    case 'color': return '#6262f5';
    case 'string': return 'OK';
    case 'json': return { ok: true };
    case 'integer': return Math.round((lo + hi) / 2);
    default: return Number(((lo + hi) / 2).toFixed(2));
  }
}

function current(c: Channel): unknown {
  const k = vkey(c);
  if (!values.has(k)) values.set(k, initial(c));
  return values.get(k);
}

const walk = (prev: number, step: number, lo: number, hi: number, pull?: number) => {
  let n = prev + (Math.random() - 0.5) * 2 * step;
  if (pull !== undefined) n += (pull - n) * 0.04;
  return clamp(n, lo, hi);
};

function next(c: Channel): unknown {
  const prev = current(c);
  const p = typeof prev === 'number' ? prev : 0;
  const t = Date.now() / 1000;
  let v: unknown;
  switch (c.key) {
    case 'temperature': v = +walk(p, 0.25, 16, 38, 26 + Math.sin(t / 90) * 1.5).toFixed(2); break;
    case 'humidity': v = +walk(p, 0.7, 30, 85, 57).toFixed(1); break;
    case 'soil_moisture': {
      const pump = values.get(`${c.device._id}:${conventionalTopics(c.device.topicPrefix, 'pump_state').telemetry}`) === true;
      v = +clamp(p + (pump ? 2.4 : -0.35) + (Math.random() - 0.5) * 0.3, 12, 92).toFixed(1);
      break;
    }
    case 'battery': v = +clamp(p - 0.015 - Math.random() * 0.02, 18, 100).toFixed(2); break;
    case 'uptime': v = Math.round(p + intervalMs / 1000); break;
    case 'pressure': v = +walk(p, 0.15, 990, 1030, 1012).toFixed(1); break;
    case 'light_level': v = Math.round(walk(p, 18, 0, 1000, 540)); break;
    case 'wind_speed': v = +walk(p, 1.4, 0, 45, 10).toFixed(1); break;
    case 'status_text': v = Math.random() < 0.04 ? (Math.random() < 0.5 ? 'OK · all sensors nominal' : 'OK · recalibrated anemometer') : prev; break;
    default: {
      const lo = c.min ?? 0;
      const hi = c.max ?? 100;
      if (c.dataType === 'boolean') v = Math.random() < 0.03 ? !prev : prev;
      else if (c.dataType === 'integer') v = Math.round(walk(p, (hi - lo) * 0.03, lo, hi));
      else if (c.dataType === 'float') v = +walk(p, (hi - lo) * 0.02, lo, hi).toFixed(2);
      else v = prev;
    }
  }
  values.set(vkey(c), v);
  return v;
}

function publishState(c: Channel) {
  if (c.stateTopic) void pub(c.stateTopic, encodeValue(current(c), c.unit), true);
}

function announce(d: DeviceDoc, state: string) {
  announced.set(String(d._id), state);
  void pub(conventionalTopics(d.topicPrefix, '').availability, JSON.stringify({ state }), true);
}

function bringOnline(d: DeviceDoc) {
  announce(d, 'connecting');
  later(() => {
    if (deviceRegistry.simMode(String(d._id)) !== 'online') return;
    announce(d, 'online');
    channelsOf(d).filter((c) => c.stateful).forEach(publishState);
  }, 700 + Math.random() * 900);
}

function syncDevices() {
  if (!enabled) return;
  const sims = deviceRegistry.simulatedDevices();
  for (const d of sims) {
    const id = String(d._id);
    if (announced.has(id)) continue;
    const mode = deviceRegistry.simMode(id);
    if (mode === 'online') bringOnline(d);
    else announce(d, mode === 'offline' ? 'offline' : mode);
  }
  for (const id of Array.from(announced.keys())) if (!sims.some((d) => String(d._id) === id)) announced.delete(id);
  void syncCommandSubscriptions();
}

/** Simulated devices with custom command topics need exact subscriptions. */
async function syncCommandSubscriptions() {
  const root = mqttConfig().topicRoot;
  const wanted = new Set<string>();
  for (const d of deviceRegistry.simulatedDevices()) for (const c of channelsOf(d)) if (c.commandTopic && !c.commandTopic.startsWith(`${root}/`)) wanted.add(c.commandTopic);
  for (const d of deviceRegistry.simulatedDevices()) for (const c of channelsOf(d)) if (c.commandTopic && c.commandTopic.startsWith(`${root}/`) && !/\/command\/[^/]+$/.test(c.commandTopic)) wanted.add(c.commandTopic);
  for (const t of wanted) if (!commandSubs.has(t)) commandSubs.set(t, await mqttConnection.subscribe(t, onCommand));
  for (const [t, u] of commandSubs) if (!wanted.has(t)) {
    commandSubs.delete(t);
    await u();
  }
}

function onCommand(m: TransportMessage) {
  const device = deviceRegistry.resolveByTopic(m.topic);
  if (!device || !device.simulated) return; // real devices answer for themselves
  const ch = channelsOf(device).find((c) => c.commandTopic === m.topic);
  if (!ch) return;
  const id = String(device._id);
  if (paused || deviceRegistry.simMode(id) !== 'online') return; // no ack → backend times the command out
  const coerced = coerceCommandValue(decodeValue(m.payload), ch.dataType, { min: ch.min, max: ch.max });
  later(() => {
    if (deviceRegistry.simMode(id) !== 'online') return;
    if (coerced.error) {
      void pub(ackTopicFor(m.topic, device.topicPrefix), JSON.stringify({ ok: false, error: coerced.error }));
      return;
    }
    values.set(vkey(ch), coerced.value);
    void pub(ackTopicFor(m.topic, device.topicPrefix), JSON.stringify({ ok: true, value: coerced.value }));
    publishState(ch);
  }, 180 + Math.random() * 420);
}

function tick() {
  if (paused) return;
  tickCount++;
  for (const d of deviceRegistry.simulatedDevices()) {
    const id = String(d._id);
    if (deviceRegistry.simMode(id) !== 'online' || announced.get(id) !== 'online') continue;
    for (const c of channelsOf(d)) {
      if (!c.stateTopic) continue;
      if (c.stateful) {
        if (tickCount % 10 === 0) publishState(c);
        continue;
      }
      void pub(c.stateTopic, encodeValue(next(c), c.unit));
    }
  }
}

export const deviceSimulator = {
  async start(opts: { intervalMs: number }): Promise<void> {
    enabled = true;
    intervalMs = opts.intervalMs;
    unsubs.push(await mqttConnection.subscribe(`${mqttConfig().topicRoot}/+/command/+`, onCommand));
    deviceRegistry.onChange(syncDevices);
    syncDevices();
    tickTimer = setInterval(tick, intervalMs);
    log().info('sim.started — simulated devices are labelled SIMULATED everywhere', { devices: deviceRegistry.simulatedDevices().length, intervalMs });
  },

  async stop(): Promise<void> {
    enabled = false;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
    for (const u of [...unsubs, ...commandSubs.values()]) await u().catch(() => undefined);
    unsubs = [];
    commandSubs.clear();
  },

  /** Give simulated devices without recent history a plausible past so charts aren't empty. */
  async backfill(samples = 150): Promise<void> {
    const since = Date.now() - samples * intervalMs;
    for (const d of deviceRegistry.simulatedDevices()) {
      const recent = await mqttMessageDao.list({ deviceId: String(d._id), kind: 'telemetry', limit: 1 });
      if (recent[0] && recent[0].at.getTime() > since) continue;
      const chans = channelsOf(d).filter((c) => !c.stateful && c.stateTopic);
      for (let i = samples; i > 0; i--) {
        const at = new Date(Date.now() - i * intervalMs);
        for (const c of chans) mqttIngestService.queueHistorical(d, c.stateTopic!, next(c), at);
      }
    }
    await mqttIngestService.flush();
  },

  status: () => ({ enabled, paused, intervalMs }),

  setPaused(p: boolean) {
    paused = p;
    log().info('sim.paused', { paused });
  },

  setIntervalMs(ms: number) {
    intervalMs = ms;
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = setInterval(tick, ms);
    }
    log().info('sim.interval', { intervalMs: ms });
  },

  /** Change one simulated device's connectivity (disconnect, error, …). */
  setMode(device: DeviceDoc, mode: SimMode) {
    const id = String(device._id);
    deviceRegistry.setSimMode(id, mode);
    if (!enabled) return;
    if (mode === 'online') bringOnline(device);
    else announce(device, mode === 'offline' ? 'offline' : mode);
  },

  /** Forget a device's simulated values (device deleted / workspace reset). */
  forget(deviceId: string) {
    for (const k of Array.from(values.keys())) if (k.startsWith(`${deviceId}:`)) values.delete(k);
    announced.delete(deviceId);
  },
};
