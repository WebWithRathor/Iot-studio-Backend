import { z } from 'zod';
import { PRODUCT_IDS, type ProductId } from '../../constants/plans.constants';
import { objectId } from '../shared/common.validation';

const providerId = z.string().regex(/^[A-Za-z0-9_]{1,80}$/, 'must be a gateway id');

export const createOrderBody = z.object({ productId: z.enum(Object.values(PRODUCT_IDS) as [ProductId, ...ProductId[]]) }).strict();

export const verifyPaymentBody = z
  .object({
    paymentId: objectId,
    providerOrderId: providerId,
    providerPaymentId: providerId,
    signature: z.string().regex(/^[a-f0-9]{64}$/, 'must be a hex signature'),
  })
  .strict();

export const mockCompleteBody = z.object({ paymentId: objectId, outcome: z.enum(['success', 'failure']) }).strict();

export const cancelPaymentBody = z.object({ paymentId: objectId, reason: z.string().trim().max(200).default('Checkout closed') }).strict();
