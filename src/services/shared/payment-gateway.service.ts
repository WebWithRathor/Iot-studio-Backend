import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadEnv } from '../../config/env.config';
import { ERROR_CODES } from '../../constants/error-codes.constants';
import type { PaymentProvider } from '../../models/payment.model';
import { AppError } from '../../utils/error.util';
import { channel } from '../../utils/logger.util';

/**
 * Payment gateway adapter.
 *
 *   mock      Built-in TEST checkout for development: orders are local, the
 *             browser shows a simulated checkout and the server completes it.
 *             No money moves. Refused in production by env validation.
 *   razorpay  Razorpay Orders API + Checkout. A payment is accepted only when
 *             the checkout signature HMAC-SHA256(order_id|payment_id, key_secret)
 *             verifies, or when a signed webhook (HMAC of the raw body with the
 *             webhook secret) reports it captured.
 *
 * Secrets never leave the server; the browser only gets the public key id.
 */

const RAZORPAY_API = 'https://api.razorpay.com/v1';

const gatewayError = (message: string) => new AppError(502, ERROR_CODES.PAYMENT_GATEWAY_ERROR, message);

/** Constant-time compare of two hex strings. */
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export const checkoutSignature = (orderId: string, paymentId: string, secret: string) => createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
export const webhookSignature = (rawBody: Buffer | string, secret: string) => createHmac('sha256', secret).update(rawBody).digest('hex');

export const paymentGateway = {
  provider: (): PaymentProvider => loadEnv().PAYMENT_PROVIDER,

  /** Public, browser-safe checkout settings. */
  publicConfig: () => {
    const e = loadEnv();
    return e.PAYMENT_PROVIDER === 'razorpay'
      ? { provider: 'razorpay' as const, keyId: e.RAZORPAY_KEY_ID!, testMode: e.RAZORPAY_KEY_ID!.startsWith('rzp_test_') }
      : { provider: 'mock' as const, keyId: null, testMode: true };
  },

  createOrder: async (input: { amount: number; currency: 'INR'; receipt: string; notes: Record<string, string> }): Promise<{ providerOrderId: string }> => {
    const e = loadEnv();
    if (e.PAYMENT_PROVIDER === 'mock') return { providerOrderId: `mock_order_${randomBytes(9).toString('hex')}` };
    const auth = Buffer.from(`${e.RAZORPAY_KEY_ID}:${e.RAZORPAY_KEY_SECRET}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(`${RAZORPAY_API}/orders`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      channel('app').error('payment.gateway.unreachable', { errorName: (err as Error).name });
      throw gatewayError('The payment gateway could not be reached. Try again in a moment.');
    }
    const body = (await res.json().catch(() => null)) as { id?: string; error?: { code?: string; description?: string } } | null;
    if (!res.ok || !body?.id) {
      channel('app').error('payment.gateway.order_failed', { status: res.status, code: body?.error?.code });
      throw gatewayError('The payment gateway refused to create the order. Try again later.');
    }
    return { providerOrderId: body.id };
  },

  /** Razorpay checkout callback signature. */
  verifyCheckout: (providerOrderId: string, providerPaymentId: string, signature: string): boolean => {
    const e = loadEnv();
    if (e.PAYMENT_PROVIDER !== 'razorpay' || !e.RAZORPAY_KEY_SECRET) return false;
    return safeEqualHex(checkoutSignature(providerOrderId, providerPaymentId, e.RAZORPAY_KEY_SECRET), signature);
  },

  verifyWebhook: (rawBody: Buffer, signature: string | undefined): boolean => {
    const secret = loadEnv().RAZORPAY_WEBHOOK_SECRET;
    if (!secret || !signature) return false;
    return safeEqualHex(webhookSignature(rawBody, secret), signature);
  },
};
