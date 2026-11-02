import { Schema, model, type Types } from 'mongoose';
import { ACTIVITY_TYPES, type ActivityType } from '../constants/app.constants';

/**
 * User-facing project activity feed (frontend "Activity" page, event-log
 * widget, home live feed). Kept separate from the admin audit log.
 * 90-day retention.
 */
export interface ActivityDoc {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  projectId: Types.ObjectId | null;
  deviceId: Types.ObjectId | null;
  type: ActivityType;
  message: string;
  at: Date;
}

const activitySchema = new Schema<ActivityDoc>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device', default: null },
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    message: { type: String, required: true, maxlength: 300 },
    at: { type: Date, default: () => new Date() },
  },
  { strict: 'throw', collection: 'activities', versionKey: false },
);

activitySchema.index({ ownerId: 1, at: -1 }, { name: 'owner_at' });
activitySchema.index({ projectId: 1, at: -1 }, { name: 'project_at' });
activitySchema.index({ at: 1 }, { expireAfterSeconds: 90 * 86400, name: 'ttl_90d' });

export const ActivityModel = model<ActivityDoc>('Activity', activitySchema);
