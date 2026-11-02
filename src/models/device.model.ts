import { Schema, model, type Types } from 'mongoose';
import { DATA_TYPES, DIRECTIONS, type DataType, type Direction } from '../constants/app.constants';
import { CONNECTION_STATES, type ConnectionState } from '../constants/mqtt.constants';
import { lmsProgramSchema, type LmsProgramRef } from './project.model';

export interface CapabilityDoc {
  key: string;
  displayName: string;
  dataType: DataType;
  direction: Direction;
  unit?: string;
  min?: number;
  max?: number;
}

export interface DeviceDoc {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  name: string;
  /** MQTT client / hardware identity, globally unique. */
  hardwareId: string;
  /** Topic namespace this device may use. The backend only routes topics under it. */
  topicPrefix: string;
  board: string;
  origin: 'studio' | 'lms';
  /** Simulated devices are driven by the backend simulator — never shown as real hardware. */
  simulated: boolean;
  status: 'active' | 'disabled';
  lmsProgram: LmsProgramRef | null;
  firmwareVersion?: string;
  capabilities: CapabilityDoc[];
  connectionState: ConnectionState;
  connectionSince: Date | null;
  lastSeenAt: Date | null;
  registeredBy: Types.ObjectId | null;
  /** Physical chip (machine.unique_id() hex) an LMS device is bound to; one active device per chip. */
  chipId?: string | null;
  /**
   * When the current broker credentials were issued. null = owed (first issue,
   * re-enable or rotation not finished yet); undefined = device predates this field.
   */
  credentialsIssuedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const capabilitySchema = new Schema<CapabilityDoc>(
  {
    key: { type: String, required: true, maxlength: 40 },
    displayName: { type: String, required: true, maxlength: 60 },
    dataType: { type: String, enum: DATA_TYPES, required: true },
    direction: { type: String, enum: DIRECTIONS, required: true },
    unit: { type: String, maxlength: 16 },
    min: Number,
    max: Number,
  },
  { _id: false },
);

const deviceSchema = new Schema<DeviceDoc>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    hardwareId: { type: String, required: true, maxlength: 48 },
    topicPrefix: { type: String, required: true, maxlength: 200 },
    board: { type: String, required: true, maxlength: 60 },
    origin: { type: String, enum: ['studio', 'lms'], required: true },
    simulated: { type: Boolean, required: true },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    lmsProgram: { type: lmsProgramSchema, default: null },
    firmwareVersion: { type: String, maxlength: 40 },
    capabilities: { type: [capabilitySchema], default: [] },
    connectionState: { type: String, enum: CONNECTION_STATES, default: 'waiting' },
    connectionSince: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
    registeredBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    chipId: { type: String, match: /^[0-9a-f]{8,32}$/, default: undefined },
    credentialsIssuedAt: { type: Date, default: undefined },
  },
  { timestamps: true, strict: 'throw', collection: 'devices' },
);

deviceSchema.index({ hardwareId: 1 }, { unique: true, name: 'uniq_hardware_id' });
deviceSchema.index({ topicPrefix: 1 }, { unique: true, name: 'uniq_topic_prefix' });
deviceSchema.index({ ownerId: 1, createdAt: 1 }, { name: 'owner_created' });
// A chip is bound to at most one ACTIVE device (disabled devices keep their chipId for history).
deviceSchema.index({ chipId: 1 }, { unique: true, name: 'uniq_active_chip', partialFilterExpression: { status: 'active', chipId: { $type: 'string' } } });

export const DeviceModel = model<DeviceDoc>('Device', deviceSchema);
