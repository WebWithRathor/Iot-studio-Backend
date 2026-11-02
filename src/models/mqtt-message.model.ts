import { Schema, model, type Types } from 'mongoose';
import { MESSAGE_KINDS, MESSAGE_STATUSES, type MessageKind, type MessageStatus } from '../constants/mqtt.constants';

/**
 * MQTT message history + telemetry samples (one collection).
 * Retention: every document carries `expireAt` (= at + MESSAGE_RETENTION_HOURS)
 * and a TTL index removes it automatically — telemetry is never kept forever.
 * Payloads are size-limited (4 KB) before they get here.
 */
export interface MqttMessageDoc {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId | null;
  deviceId: Types.ObjectId | null;
  topic: string;
  direction: 'in' | 'out';
  payload: string;
  kind: MessageKind;
  status: MessageStatus;
  simulated: boolean;
  qos: 0 | 1;
  retain: boolean;
  /** Numeric sample extracted from telemetry, for charts. */
  num: number | null;
  /** For acks: the command message it acknowledges. */
  ackFor: Types.ObjectId | null;
  /** Who published (outgoing commands only). */
  publishedBy: Types.ObjectId | null;
  at: Date;
  expireAt: Date;
}

const mqttMessageSchema = new Schema<MqttMessageDoc>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device', default: null },
    topic: { type: String, required: true, maxlength: 200 },
    direction: { type: String, enum: ['in', 'out'], required: true },
    payload: { type: String, required: true, maxlength: 4096 },
    kind: { type: String, enum: MESSAGE_KINDS, required: true },
    status: { type: String, enum: MESSAGE_STATUSES, required: true },
    simulated: { type: Boolean, required: true },
    qos: { type: Number, enum: [0, 1], default: 0 },
    retain: { type: Boolean, default: false },
    num: { type: Number, default: null },
    ackFor: { type: Schema.Types.ObjectId, default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    at: { type: Date, required: true },
    expireAt: { type: Date, required: true },
  },
  { strict: 'throw', collection: 'mqtt_messages', versionKey: false },
);

mqttMessageSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_expire' });
mqttMessageSchema.index({ ownerId: 1, at: -1 }, { name: 'owner_at' });
mqttMessageSchema.index({ deviceId: 1, at: -1 }, { name: 'device_at' });
mqttMessageSchema.index({ topic: 1, at: -1 }, { name: 'topic_at' });

export const MqttMessageModel = model<MqttMessageDoc>('MqttMessage', mqttMessageSchema);
