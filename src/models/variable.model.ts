import { Schema, model, type Types } from 'mongoose';
import { DATA_TYPES, DIRECTIONS, type DataType, type Direction } from '../constants/app.constants';

/**
 * A LOGICAL variable that dashboard widgets bind to. Distinct from:
 *   - the MQTT topics it maps to (stateTopic / commandTopic)
 *   - the firmware variable implementing it (firmwareRef: the LMS "declare IoT variable" block,
 *     set by the LMS integration; `declared: false` once the firmware no longer declares it)
 *   - its latest reported value (runtime state in Redis, history in mqtt_messages)
 */
export interface FirmwareRef {
  source: 'lms';
  blockId: string;
  variableName: string;
  /** False when the latest flashed program no longer declares this variable. */
  declared?: boolean;
}

export interface VariableDoc {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  ownerId: Types.ObjectId;
  key: string;
  displayName: string;
  dataType: DataType;
  direction: Direction;
  deviceId: Types.ObjectId | null;
  stateTopic?: string;
  commandTopic?: string;
  unit?: string;
  min?: number;
  max?: number;
  firmwareRef: FirmwareRef | null;
  createdAt: Date;
  updatedAt: Date;
}

const variableSchema = new Schema<VariableDoc>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    key: { type: String, required: true, maxlength: 40 },
    displayName: { type: String, required: true, maxlength: 60 },
    dataType: { type: String, enum: DATA_TYPES, required: true },
    direction: { type: String, enum: DIRECTIONS, required: true },
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device', default: null },
    stateTopic: { type: String, maxlength: 200 },
    commandTopic: { type: String, maxlength: 200 },
    unit: { type: String, maxlength: 16 },
    min: Number,
    max: Number,
    firmwareRef: {
      type: new Schema({ source: { type: String, enum: ['lms'] }, blockId: String, variableName: String, declared: { type: Boolean, default: true } }, { _id: false }),
      default: null,
    },
  },
  { timestamps: true, strict: 'throw', collection: 'variables' },
);

variableSchema.index({ projectId: 1, key: 1 }, { unique: true, name: 'uniq_project_key' });
variableSchema.index({ ownerId: 1, projectId: 1 }, { name: 'owner_project' });
variableSchema.index({ deviceId: 1 }, { name: 'device' });
variableSchema.index({ stateTopic: 1 }, { name: 'state_topic', sparse: true });
variableSchema.index({ commandTopic: 1 }, { name: 'command_topic', sparse: true });

export const VariableModel = model<VariableDoc>('Variable', variableSchema);
