import { loadEnv } from '../../config/env.config';
import { ERROR_CODES } from '../../constants/error-codes.constants';
import { PLAN_LABELS, PLANS, PRODUCT_IDS, type Plan, type ProductId } from '../../constants/plans.constants';
import { paymentDao } from '../../dao/payment.dao';
import { userDao } from '../../dao/user.dao';
import { withTransaction } from '../../database/mongo.transactions';
import type { PaymentDoc } from '../../models/payment.model';
import type { TokenStateDTO } from '../../types/token.types';
import { toEpoch, toEpochOrNull } from '../../utils/date.util';
import { AppError, notFound, unauthenticated, unsupported } from '../../utils/error.util';
import { oid } from '../../utils/id.util';
import { channel, traced } from '../../utils/logger.util';
import { auditLogService } from '../private/audit-log.service';
import { applyKitCode } from '../shared/kit-code.service';
import { paymentGateway } from '../shared/payment-gateway.service';
import { planAllowances, tokenWallet } from '../shared/token-wallet.service';

export interface ProductDTO {
  id: ProductId;
  name: string;
  description: string;
  plan: Plan;
  tokens: number;
  /** Paise. */
  amount: number;
  currency: 'INR';
}

export interface PaymentDTO {
  id: string;
  productId: string;
  productName: string;
  plan: Plan;
  tokens: number;
  amount: number;
  currency: 'INR';
  status: PaymentDoc['status'];
  provider: PaymentDoc['provider'];
  providerOrderId: string;
  providerPaymentId: string | null;
  failureReason: string | null;
  createdAt: number;
  paidAt: number | null;
}

export function products(): ProductDTO[] {
  const e = loadEnv();
  return [
    {
      id: PRODUCT_IDS.PLUS_PACK,
      name: 'Plus — 10,000 tokens',
      description: `Upgrade to the Plus plan: ${planAllowances().PLUS.toLocaleString('en-IN')} tokens for more projects and dashboards. Bought again (or on Premium), it adds another ${planAllowances().PLUS.toLocaleString('en-IN')}.`,
      plan: PLANS.PLUS,
      tokens: planAllowances().PLUS,
      amount: e.PLUS_PACK_PRICE_INR * 100,
      currency: 'INR',
    },
  ];
}

const productById = (id: string) => products().find((p) => p.id === id) ?? null;

const toDTO = (p: PaymentDoc): PaymentDTO => ({
  id: String(p._id),
  productId: p.productId,
  productName: productById(p.productId)?.name ?? p.productId,
  plan: p.plan,
  tokens: p.tokens,
  amount: p.amount,
  currency: p.currency,
  status: p.status,
  provider: p.provider,
  providerOrderId: p.providerOrderId,
  providerPaymentId: p.providerPaymentId,
  failureReason: p.failureReason,
  createdAt: toEpoch(p.createdAt),
  paidAt: toEpochOrNull(p.paidAt),
});

const verificationFailed = () => new AppError(400, ERROR_CODES.PAYMENT_VERIFICATION_FAILED, 'The payment could not be verified. If money was taken it will be confirmed automatically or refunded by the gateway.');

/**
 * Credit the purchase exactly once. markPaid is the idempotency gate: a
 * second verify / webhook for the same payment finds it no longer `created`.
 */
async function fulfil(payment: PaymentDoc, providerPaymentId: string, source: 'checkout' | 'webhook' | 'mock'): Promise<boolean> {
  const id = String(payment._id);
  const userId = String(payment.userId);
  const done = await withTransaction('payment.fulfil', async (session) => {
    const paid = await paymentDao.markPaid(id, providerPaymentId, session);
    if (!paid) return null; // already fulfilled (or failed)
    try {
      const user = await userDao.findById(userId, session);
      if (!user) throw unauthenticated();
      const next = applyKitCode({ plan: user.plan ?? PLANS.FREE, bonusTokens: user.bonusTokens ?? 0 }, { plan: payment.plan, bonusTokens: 0 }, planAllowances());
      await userDao.setPlan(userId, { plan: next.plan, bonusTokens: next.bonusTokens }, session);
      await paymentDao.setResult(id, { plan: next.plan, bonusTokens: next.bonusTokens, upgraded: next.upgraded }, session);
      return { from: user.plan ?? PLANS.FREE, to: next.plan };
    } catch (err) {
      if (!session) await paymentDao.revertPaid(id).catch(() => undefined);
      throw err;
    }
  });
  if (done) {
    await auditLogService.record({
      action: 'payment.paid', outcome: 'success', actor: { id: userId }, target: { type: 'payment', id },
      metadata: { provider: payment.provider, amount: payment.amount, currency: payment.currency, productId: payment.productId, from: done.from, to: done.to, source },
    });
    channel('app').info('payment.fulfilled', { paymentId: id, provider: payment.provider, source });
  }
  return Boolean(done);
}

export const paymentService = {
  catalog: () =>
    traced('PaymentService.catalog', async () => ({ products: products(), checkout: paymentGateway.publicConfig(), plans: planAllowances(), planLabels: PLAN_LABELS })),

  createOrder: (userId: string, productId: string, prefill: { name: string; email: string }) =>
    traced('PaymentService.createOrder', async () => {
      const product = productById(productId);
      if (!product) throw notFound('Product');
      const provider = paymentGateway.provider();
      const { providerOrderId } = await paymentGateway.createOrder({ amount: product.amount, currency: product.currency, receipt: `kk_${Date.now().toString(36)}`, notes: { userId, productId: product.id } });
      const payment = await paymentDao.create({ userId: oid(userId), provider, productId: product.id, plan: product.plan, tokens: product.tokens, amount: product.amount, currency: product.currency, providerOrderId });
      return { payment: toDTO(payment), checkout: { ...paymentGateway.publicConfig(), orderId: providerOrderId, amount: product.amount, currency: product.currency, name: 'Kokoon IoT Studio', description: product.name, prefill } };
    }),

  /** Razorpay checkout success callback: verify the signature, then credit. */
  verify: (userId: string, input: { paymentId: string; providerOrderId: string; providerPaymentId: string; signature: string }) =>
    traced('PaymentService.verify', async (): Promise<{ payment: PaymentDTO; tokens: TokenStateDTO }> => {
      const p = await paymentDao.findOwned(input.paymentId, userId);
      if (!p || p.provider !== 'razorpay' || p.providerOrderId !== input.providerOrderId) throw verificationFailed();
      if (!paymentGateway.verifyCheckout(p.providerOrderId, input.providerPaymentId, input.signature)) {
        await auditLogService.record({ action: 'payment.verify.failed', outcome: 'denied', actor: { id: userId }, target: { type: 'payment', id: input.paymentId } });
        throw verificationFailed();
      }
      if (p.status === 'created') await fulfil(p, input.providerPaymentId, 'checkout');
      const now = await paymentDao.findOwned(input.paymentId, userId);
      return { payment: toDTO(now!), tokens: await tokenWallet.state(userId) };
    }),

  /** Development test checkout: simulate the gateway's answer. Only with PAYMENT_PROVIDER=mock (never in production). */
  completeMock: (userId: string, paymentId: string, outcome: 'success' | 'failure') =>
    traced('PaymentService.completeMock', async (): Promise<{ payment: PaymentDTO; tokens: TokenStateDTO }> => {
      const e = loadEnv();
      if (e.PAYMENT_PROVIDER !== 'mock' || e.NODE_ENV === 'production') throw unsupported('The test checkout is disabled on this server.');
      const p = await paymentDao.findOwned(paymentId, userId);
      if (!p || p.provider !== 'mock') throw notFound('Payment');
      if (p.status === 'created') {
        if (outcome === 'success') await fulfil(p, `mock_pay_${Date.now().toString(36)}`, 'mock');
        else await paymentDao.markFailed(paymentId, 'Declined in the test checkout');
      }
      const now = await paymentDao.findOwned(paymentId, userId);
      return { payment: toDTO(now!), tokens: await tokenWallet.state(userId) };
    }),

  /** The user closed the checkout or the gateway reported a failure. */
  cancel: (userId: string, paymentId: string, reason: string) =>
    traced('PaymentService.cancel', async (): Promise<PaymentDTO> => {
      const p = await paymentDao.findOwned(paymentId, userId);
      if (!p) throw notFound('Payment');
      // Only abandon local test orders. A real order may still be paid (UPI can confirm late): the webhook decides.
      const updated = p.status === 'created' && p.provider === 'mock' ? await paymentDao.markFailed(paymentId, reason) : null;
      return toDTO(updated ?? p);
    }),

  history: (userId: string) => traced('PaymentService.history', async () => (await paymentDao.listOwned(userId)).map(toDTO)),

  /** Razorpay webhook (signed raw body). Always answers quickly; unknown events are ignored. */
  webhook: (rawBody: Buffer, signature: string | undefined) =>
    traced('PaymentService.webhook', async (): Promise<{ handled: boolean }> => {
      if (!paymentGateway.verifyWebhook(rawBody, signature)) {
        await auditLogService.record({ action: 'payment.webhook.rejected', outcome: 'denied' });
        throw verificationFailed();
      }
      const evt = JSON.parse(rawBody.toString('utf8')) as { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string; amount?: number; error_description?: string } } } };
      const entity = evt.payload?.payment?.entity;
      if (!entity?.order_id || !entity.id) return { handled: false };
      const p = await paymentDao.findByProviderOrder('razorpay', entity.order_id);
      if (!p) return { handled: false };
      if ((evt.event === 'payment.captured' || evt.event === 'order.paid') && p.status === 'created') {
        if (entity.amount !== undefined && entity.amount !== p.amount) {
          channel('app').error('payment.webhook.amount_mismatch', { paymentId: String(p._id) });
          return { handled: false };
        }
        await fulfil(p, entity.id, 'webhook');
        return { handled: true };
      }
      if (evt.event === 'payment.failed' && p.status === 'created') {
        await paymentDao.markFailed(String(p._id), entity.error_description ?? 'Payment failed');
        return { handled: true };
      }
      return { handled: false };
    }),
};
