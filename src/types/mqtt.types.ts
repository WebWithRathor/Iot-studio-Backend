import type { ConnectionState, MessageKind, MessageStatus, MqttMode, SimMode } from '../constants/mqtt.constants';
import type { ActivityEventDTO } from './project.types';

/** Matches the frontend `MqttMessage` model. */
export interface MqttMessageDTO {
  id: string;
  at: number;
  topic: string;
  direction: 'in' | 'out';
  payload: string;
  kind: MessageKind;
  status: MessageStatus;
  deviceId: string | null;
  simulated: boolean;
  qos: 0 | 1;
  retain?: boolean;
  /** For acks: id of the command message this acknowledges (server-side correlation). */
  ackFor?: string;
}

export interface DeviceRuntimeDTO {
  state: ConnectionState;
  lastSeen: number | null;
  since: number;
  messageCount: number;
  telemetrySeen: boolean;
  simMode?: SimMode;
}

export interface CommandStateDTO {
  status: 'pending' | 'acknowledged' | 'failed';
  at: number;
  ackAt?: number;
  value: unknown;
  messageId: string;
  reason?: string;
}

export interface MqttStatusDTO {
  mode: MqttMode;
  transport: string;
  broker: ConnectionState;
  simulation: { enabled: boolean; paused: boolean; intervalMs: number };
  topicRoot: string;
}

export interface TelemetrySampleDTO {
  t: number;
  v: number;
}

export interface SnapshotDTO {
  status: MqttStatusDTO;
  values: Record<string, { value: unknown; at: number }>;
  history: Record<string, TelemetrySampleDTO[]>;
  messages: MqttMessageDTO[];
  devices: Record<string, DeviceRuntimeDTO>;
  commands: Record<string, CommandStateDTO>;
  serverTime: number;
}

/** Server-sent events delivered on GET /mqtt/stream. */
export type RealtimeEvent =
  | { type: 'message'; data: MqttMessageDTO }
  | { type: 'device'; data: { deviceId: string; runtime: DeviceRuntimeDTO } }
  | { type: 'command'; data: { topic: string; command: CommandStateDTO } }
  | { type: 'activity'; data: ActivityEventDTO }
  | { type: 'status'; data: MqttStatusDTO }
  | { type: 'workspace'; data: { reason: string } };

/** Normalised inbound message handed to the MQTT pipeline. */
export interface TransportMessage {
  topic: string;
  payload: string;
  qos: 0 | 1;
  retain: boolean;
  /** Set by the in-process loopback when the sender is the backend itself. */
  origin?: 'backend' | 'simulator' | 'external';
}
