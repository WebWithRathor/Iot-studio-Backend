import { Schema, model, type Types } from 'mongoose';
import { ALL_PLANS, MAX_BONUS_TOKENS, type Plan } from '../constants/plans.constants';

/**
 * Activation code printed in a Kokoon kit box. Redeeming it upgrades the
 * account's plan (and/or adds bonus tokens). Only a SHA-256 hash of the code
 * is stored — like a password, the plain code is shown once when generated.
 */
export interface KitCodeDoc {
  _id: Types.ObjectId;
  codeHash: string;
  /** Last 4 characters, so admins can recognise a code without storing it. */
  last4: string;
  plan: Plan;
  bonusTokens: number;
  note: string;
  createdBy: Types.ObjectId;
  redeemedBy: Types.ObjectId | null;
  redeemedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const kitCodeSchema = new Schema<KitCodeDoc>(
  {
    codeHash: { type: String, required: true, maxlength: 64 },
    last4: { type: String, required: true, maxlength: 4 },
    plan: { type: String, enum: ALL_PLANS, required: true },
    bonusTokens: { type: Number, default: 0, min: 0, max: MAX_BONUS_TOKENS },
    note: { type: String, default: '', maxlength: 120 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    redeemedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    redeemedAt: { type: Date, default: null },
  },
  { timestamps: true, strict: 'throw', collection: 'kit_codes' },
);

kitCodeSchema.index({ codeHash: 1 }, { unique: true, name: 'uniq_code' });
kitCodeSchema.index({ createdAt: -1 }, { name: 'created_desc' });

export const KitCodeModel = model<KitCodeDoc>('KitCode', kitCodeSchema);
