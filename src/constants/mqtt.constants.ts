import type { DataType, Direction } from './app.constants';

export const MQTT_MODES = ['simulated', 'broker'] as const;
export type MqttMode = (typeof MQTT_MODES)[number];

export const MESSAGE_KINDS = ['telemetry', 'command', 'ack', 'availability'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const MESSAGE_STATUSES = ['received', 'pending', 'sent', 'acknowledged', 'failed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const CONNECTION_STATES = ['connected', 'connecting', 'disconnected', 'waiting', 'auth_required', 'error'] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const SIM_MODES = ['online', 'offline', 'error', 'auth_required'] as const;
export type SimMode = (typeof SIM_MODES)[number];

/** Availability payload `{"state": ...}` → connection state. */
export const AVAILABILITY_TO_STATE: Readonly<Record<string, ConnectionState>> = {
  online: 'connected',
  offline: 'disconnected',
  connecting: 'connecting',
  error: 'error',
  auth_required: 'auth_required',
};

export const MQTT_LIMITS = {
  MAX_TOPIC_LENGTH: 200,
  MAX_TOPIC_LEVELS: 10,
  MAX_PAYLOAD_BYTES: 4096,
  /** Upper bound for one SUBSCRIBE packet we send: half the broker's `max_packet_size 8192`, which drops the connection on anything bigger. */
  SUBSCRIBE_PACKET_MAX_BYTES: 4096,
  ACK_TIMEOUT_MS: 5000,
  PENDING_COMMAND_TTL_S: 30,
  LAST_SEEN_PERSIST_INTERVAL_MS: 30_000,
  MESSAGE_FLUSH_INTERVAL_MS: 1000,
  /** Documents waiting for insert (the batch in flight is not counted). Oldest dropped beyond it, and counted. */
  MESSAGE_BUFFER_MAX: 20_000,
  MESSAGE_FLUSH_CHUNK: 1000,
  MESSAGE_FLUSH_MAX_ATTEMPTS: 3,
  INGEST_STATS_INTERVAL_MS: 60_000,
  SSE_HEARTBEAT_MS: 25_000,
  SSE_MAX_CONNECTIONS_PER_USER: 6,
  /** A stream whose socket stays unwritable (write() returned false, no 'drain') this long is closed. */
  SSE_STUCK_MS: 30_000,
  /** …or whose unsent buffer grows past this. */
  SSE_MAX_BUFFERED_BYTES: 512 * 1024,
  /** Base SSE `retry:` hint; each stream adds random jitter so a restart does not bring every browser back at once. */
  SSE_RETRY_MS: 3000,
  SSE_RETRY_JITTER_MS: 4000,
} as const;

/** Variables a device's firmware may declare. Mirrors the frontend's catalogue. */
export interface CapabilityTemplate {
  key: string;
  displayName: string;
  dataType: DataType;
  direction: Direction;
  unit?: string;
  min?: number;
  max?: number;
}

export const CAPABILITIES: Readonly<Record<string, CapabilityTemplate>> = {
  temperature: { key: 'temperature', displayName: 'Temperature', dataType: 'float', direction: 'telemetry', unit: '°C', min: 0, max: 50 },
  humidity: { key: 'humidity', displayName: 'Humidity', dataType: 'float', direction: 'telemetry', unit: '%', min: 0, max: 100 },
  led_state: { key: 'led_state', displayName: 'LED', dataType: 'boolean', direction: 'bidirectional' },
  motor_speed: { key: 'motor_speed', displayName: 'Motor speed', dataType: 'integer', direction: 'bidirectional', unit: 'PWM', min: 0, max: 255 },
  rgb_color: { key: 'rgb_color', displayName: 'RGB color', dataType: 'color', direction: 'bidirectional' },
  uptime: { key: 'uptime', displayName: 'Uptime', dataType: 'integer', direction: 'telemetry', unit: 's' },
  light_level: { key: 'light_level', displayName: 'Light level', dataType: 'integer', direction: 'telemetry', unit: 'lux', min: 0, max: 1000 },
  buzzer: { key: 'buzzer', displayName: 'Buzzer', dataType: 'boolean', direction: 'command' },
  soil_moisture: { key: 'soil_moisture', displayName: 'Soil moisture', dataType: 'float', direction: 'telemetry', unit: '%', min: 0, max: 100 },
  pump_state: { key: 'pump_state', displayName: 'Water pump', dataType: 'boolean', direction: 'bidirectional' },
  battery: { key: 'battery', displayName: 'Battery', dataType: 'float', direction: 'telemetry', unit: '%', min: 0, max: 100 },
  pressure: { key: 'pressure', displayName: 'Pressure', dataType: 'float', direction: 'telemetry', unit: 'hPa', min: 980, max: 1040 },
  wind_speed: { key: 'wind_speed', displayName: 'Wind speed', dataType: 'float', direction: 'telemetry', unit: 'km/h', min: 0, max: 60 },
  status_text: { key: 'status_text', displayName: 'Status message', dataType: 'string', direction: 'telemetry' },
  brightness: { key: 'brightness', displayName: 'Brightness', dataType: 'integer', direction: 'bidirectional', unit: '%', min: 0, max: 100 },
};

/** Firmware presets a user can pick when adding a simulated device. */
export const DEVICE_KITS: Readonly<Record<string, { label: string; caps: string[] }>> = {
  sensor: { label: 'Sensor kit — temperature, humidity, light', caps: ['temperature', 'humidity', 'light_level', 'uptime'] },
  actuator: { label: 'Actuator kit — LED, motor, RGB', caps: ['led_state', 'motor_speed', 'rgb_color', 'uptime'] },
  garden: { label: 'Garden kit — soil moisture, pump, battery', caps: ['soil_moisture', 'pump_state', 'battery', 'temperature'] },
  full: { label: 'Full bench — sensors + actuators', caps: ['temperature', 'humidity', 'led_state', 'motor_speed', 'rgb_color', 'light_level', 'uptime'] },
};

export const DEVICE_BOARDS = ['ESP32-S3 DevKitC', 'ESP32-C3 Mini', 'Kokoon BrainBoard', 'ESP32 WROOM-32'] as const;
