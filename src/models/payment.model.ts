import { Schema, model, type Types } from 'mongoose';
import { ALL_PLANS, type Plan } from '../constants/plans.constants';

export type PaymentStatus = 'created' | 'paid' | 'failed';
export type PaymentProvider = 'mock' | 'razorpay';

/**
 * One checkout attempt. Created before the gateway opens; moved to `paid`
 * exactly once (atomic status transition) by signature verification OR the
 * gateway webhook — whichever arrives first — and only then are tokens added.
 * Amounts are in the smallest currency unit (paise).
 */
export interface PaymentDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  provider: PaymentProvider;
  productId: string;
  plan: Plan;
  tokens: number;
  amount: number;
  currency: 'INR';
  status: PaymentStatus;
  providerOrderId: string;
  providerPaymentId: string | null;
  failureReason: string | null;
  /** What the account looked like after fulfilment (for receipts / support). */
  result: { plan: Plan; bonusTokens: number; upgraded: boolean } | null;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<PaymentDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: String, enum: ['mock', 'razorpay'], required: true },
    productId: { type: String, required: true, maxlength: 40 },
    plan: { type: String, enum: ALL_PLANS, required: true },
    tokens: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, enum: ['INR'], required: true },
    status: { type: String, enum: ['created', 'paid', 'failed'], default: 'created', required: true },
    providerOrderId: { type: String, required: true, maxlength: 80 },
    providerPaymentId: { type: String, default: null, maxlength: 80 },
    failureReason: { type: String, default: null, maxlength: 200 },
    result: {
      type: new Schema({ plan: { type: String, enum: ALL_PLANS }, bonusTokens: Number, upgraded: Boolean }, { _id: false }),
      default: null,
    },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true, strict: 'throw', collection: 'payments' },
);

paymentSchema.index({ provider: 1, providerOrderId: 1 }, { unique: true, name: 'uniq_provider_order' });
paymentSchema.index({ userId: 1, createdAt: -1 }, { name: 'user_created' });

export const PaymentModel = model<PaymentDoc>('Payment', paymentSchema);
