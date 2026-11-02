import { loadEnv } from './env.config';
import { MQTT_LIMITS } from '../constants/mqtt.constants';

/**
 * MQTT configuration. Credentials stay on the server — the browser never
 * receives broker credentials, it talks to the backend over HTTP + SSE.
 */
export function mqttConfig() {
  const e = loadEnv();
  return {
    mode: e.MQTT_MODE,
    brokerUrl: e.MQTT_BROKER_URL,
    username: e.MQTT_USERNAME,
    password: e.MQTT_PASSWORD,
    clientId: `${e.MQTT_CLIENT_ID}-${process.pid}`,
    topicRoot: e.MQTT_TOPIC_ROOT,
    demoSimulation: e.DEMO_SIMULATION,
    simIntervalMs: e.SIM_INTERVAL_MS,
    retentionHours: e.MESSAGE_RETENTION_HOURS,
    persistTelemetry: e.PERSIST_TELEMETRY,
    telemetryPersistIntervalMs: e.TELEMETRY_PERSIST_INTERVAL_MS,
    maxPayloadBytes: MQTT_LIMITS.MAX_PAYLOAD_BYTES,
    reconnectPeriodMs: 3000,
    connectTimeoutMs: 10_000,
  };
}
