import type { ClientSession } from 'mongoose';
import { PaymentModel, type PaymentDoc, type PaymentProvider } from '../models/payment.model';
import { dbOp } from '../utils/logger.util';
import { oid } from '../utils/id.util';

const E = 'Payment';

export const paymentDao = {
  create: (data: Pick<PaymentDoc, 'userId' | 'provider' | 'productId' | 'plan' | 'tokens' | 'amount' | 'currency' | 'providerOrderId'>) =>
    dbOp(E, 'create', async () => (await PaymentModel.create(data)).toObject() as PaymentDoc),

  findOwned: (id: string, userId: string) =>
    dbOp(E, 'findOwned', () => PaymentModel.findOne({ _id: oid(id), userId: oid(userId) }).lean<PaymentDoc>().exec(), { id }),

  findByProviderOrder: (provider: PaymentProvider, providerOrderId: string) =>
    dbOp(E, 'findByProviderOrder', () => PaymentModel.findOne({ provider, providerOrderId }).lean<PaymentDoc>().exec()),

  /** created → paid, at most once. Null when it was already paid/failed (idempotency). */
  markPaid: (id: string, providerPaymentId: string, session?: ClientSession) =>
    dbOp(E, 'markPaid', () =>
      PaymentModel.findOneAndUpdate({ _id: oid(id), status: 'created' }, { $set: { status: 'paid', providerPaymentId, paidAt: new Date() } }, { new: true, session }).lean<PaymentDoc>().exec(), { id }),

  setResult: (id: string, result: PaymentDoc['result'], session?: ClientSession) =>
    dbOp(E, 'setResult', () => PaymentModel.updateOne({ _id: oid(id) }, { $set: { result } }, { session }).exec(), { id }),

  /** Undo markPaid when fulfilment failed without a transaction. */
  revertPaid: (id: string) =>
    dbOp(E, 'revertPaid', () => PaymentModel.updateOne({ _id: oid(id), status: 'paid', result: null }, { $set: { status: 'created', providerPaymentId: null, paidAt: null } }).exec(), { id }),

  markFailed: (id: string, reason: string) =>
    dbOp(E, 'markFailed', () => PaymentModel.findOneAndUpdate({ _id: oid(id), status: 'created' }, { $set: { status: 'failed', failureReason: reason.slice(0, 200) } }, { new: true }).lean<PaymentDoc>().exec(), { id }),

  listOwned: (userId: string, limit = 50) =>
    dbOp(E, 'listOwned', () => PaymentModel.find({ userId: oid(userId) }).sort({ createdAt: -1 }).limit(limit).lean<PaymentDoc[]>().exec()),
};
