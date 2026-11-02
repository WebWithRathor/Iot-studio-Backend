import { Schema, model, type Types } from 'mongoose';
import { PROJECT_ACCENTS, PROJECT_CATEGORIES, PROJECT_ICONS } from '../constants/app.constants';

export interface LmsProgramRef {
  programId: string;
  name: string;
  version?: string;
  source: 'mock' | 'lms';
}

export interface ProjectDoc {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  name: string;
  description: string;
  category: string;
  icon: string;
  accent: string;
  /** Associations only — devices are shared records owned by a user, never copied per project. */
  deviceIds: Types.ObjectId[];
  dashboardIds: Types.ObjectId[];
  defaultDashboardId: Types.ObjectId | null;
  lmsProgram: LmsProgramRef | null;
  settings: { density: 'compact' | 'comfortable'; showWidgetHeaders: boolean };
  /** Sample project from the demo workspace: costs no tokens. Copies and imports are never samples. */
  sample?: boolean;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const lmsProgramSchema = new Schema<LmsProgramRef>(
  {
    programId: { type: String, required: true, maxlength: 64 },
    name: { type: String, required: true, maxlength: 120 },
    version: { type: String, maxlength: 32 },
    source: { type: String, enum: ['mock', 'lms'], required: true },
  },
  { _id: false },
);

const projectSchema = new Schema<ProjectDoc>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, default: '', maxlength: 500 },
    category: { type: String, enum: PROJECT_CATEGORIES, default: 'Custom' },
    icon: { type: String, enum: PROJECT_ICONS, default: 'LuHouse' },
    accent: { type: String, enum: PROJECT_ACCENTS, default: 'indigo' },
    deviceIds: [{ type: Schema.Types.ObjectId, ref: 'Device' }],
    dashboardIds: [{ type: Schema.Types.ObjectId, ref: 'Dashboard' }],
    defaultDashboardId: { type: Schema.Types.ObjectId, ref: 'Dashboard', default: null },
    lmsProgram: { type: lmsProgramSchema, default: null },
    settings: {
      density: { type: String, enum: ['compact', 'comfortable'], default: 'comfortable' },
      showWidgetHeaders: { type: Boolean, default: true },
    },
    sample: { type: Boolean, default: false },
    lastActivityAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true, strict: 'throw', collection: 'projects' },
);

projectSchema.index({ ownerId: 1, updatedAt: -1 }, { name: 'owner_updated' });
projectSchema.index({ ownerId: 1, deviceIds: 1 }, { name: 'owner_devices' });

export const ProjectModel = model<ProjectDoc>('Project', projectSchema);
