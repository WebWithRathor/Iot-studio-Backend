import { Schema, model, type Types } from 'mongoose';

/**
 * Security audit trail (admin-only). Separate from diagnostic logs and from
 * the user-facing project activity feed. Never stores credentials, tokens or
 * full documents — only ids, the action and small sanitised metadata.
 */
export interface AuditLogDoc {
  _id: Types.ObjectId;
  action: string;
  outcome: 'success' | 'failure' | 'denied';
  actorId: Types.ObjectId | null;
  actorRole: string | null;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  ipHash: string | null;
  metadata: Record<string, unknown>;
  at: Date;
}

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    action: { type: String, required: true, maxlength: 60 },
    outcome: { type: String, enum: ['success', 'failure', 'denied'], required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorRole: { type: String, default: null },
    targetType: { type: String, default: null, maxlength: 30 },
    targetId: { type: String, default: null, maxlength: 64 },
    requestId: { type: String, default: null, maxlength: 64 },
    ipHash: { type: String, default: null, maxlength: 64 },
    metadata: { type: Schema.Types.Mixed, default: {} },
    at: { type: Date, default: () => new Date() },
  },
  { strict: 'throw', collection: 'audit_logs', versionKey: false },
);

auditLogSchema.index({ at: -1 }, { name: 'at_desc' });
auditLogSchema.index({ actorId: 1, at: -1 }, { name: 'actor_at' });
auditLogSchema.index({ action: 1, at: -1 }, { name: 'action_at' });
auditLogSchema.index({ at: 1 }, { expireAfterSeconds: 365 * 86400, name: 'ttl_1y' });

export const AuditLogModel = model<AuditLogDoc>('AuditLog', auditLogSchema);
