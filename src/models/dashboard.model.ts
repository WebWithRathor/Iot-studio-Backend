import { Schema, model, type Types } from 'mongoose';
import { widgetSchema, type WidgetDoc } from './widget.model';

export interface DashboardDoc {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  ownerId: Types.ObjectId;
  name: string;
  widgets: WidgetDoc[];
  /** Incremented on every widget save — optimistic concurrency for the editor. */
  revision: number;
  /** Widgets that cost no tokens (the ones a sample dashboard ships with). */
  freeWidgets?: number;
  createdAt: Date;
  updatedAt: Date;
}

const dashboardSchema = new Schema<DashboardDoc>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    widgets: { type: [widgetSchema], default: [] },
    revision: { type: Number, default: 0, min: 0 },
    freeWidgets: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, strict: 'throw', collection: 'dashboards' },
);

dashboardSchema.index({ ownerId: 1, projectId: 1 }, { name: 'owner_project' });
dashboardSchema.index({ projectId: 1, createdAt: 1 }, { name: 'project_created' });

export const DashboardModel = model<DashboardDoc>('Dashboard', dashboardSchema);
