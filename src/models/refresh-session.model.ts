import { Schema, model, type Types } from 'mongoose';

/**
 * Durable record of a login session (one per sign-in, rotated in place).
 * Redis holds the live state used on every request (fast revocation);
 * this collection keeps the history for admins and survives a Redis flush
 * for audit purposes. Only a SHA-256 hash of the current refresh-token id is
 * stored — never the token. IP and user agent are encrypted at rest.
 */
export interface RefreshSessionDoc {
  _id: Types.ObjectId;
  sid: string;
  userId: Types.ObjectId;
  currentJtiHash: string;
  rotations: number;
  /** AES-256-GCM ciphertext (encryption.service) of { ip, userAgent }. */
  clientInfoEnc: string | null;
  createdAt: Date;
  lastRotatedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
}

const refreshSessionSchema = new Schema<RefreshSessionDoc>(
  {
    sid: { type: String, required: true, maxlength: 64 },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    currentJtiHash: { type: String, required: true, maxlength: 64 },
    rotations: { type: Number, default: 0 },
    clientInfoEnc: { type: String, default: null, maxlength: 2048 },
    createdAt: { type: Date, default: () => new Date() },
    lastRotatedAt: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, default: null, maxlength: 60 },
  },
  { strict: 'throw', collection: 'refresh_sessions', versionKey: false },
);

refreshSessionSchema.index({ sid: 1 }, { unique: true, name: 'uniq_sid' });
refreshSessionSchema.index({ userId: 1, createdAt: -1 }, { name: 'user_created' });
refreshSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_expire' });

export const RefreshSessionModel = model<RefreshSessionDoc>('RefreshSession', refreshSessionSchema);
