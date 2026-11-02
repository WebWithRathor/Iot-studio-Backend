import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { checkoutSignature, safeEqualHex, webhookSignature } from '../../src/services/shared/payment-gateway.service';

describe('payment signatures (Razorpay scheme)', () => {
  const secret = 'test_secret_123';

  it('checkout signature is HMAC-SHA256 of "order_id|payment_id"', () => {
    const expected = createHmac('sha256', secret).update('order_ABC|pay_XYZ').digest('hex');
    assert.equal(checkoutSignature('order_ABC', 'pay_XYZ', secret), expected);
  });

  it('a signature for another payment or secret does not verify', () => {
    const good = checkoutSignature('order_ABC', 'pay_XYZ', secret);
    assert.equal(safeEqualHex(checkoutSignature('order_ABC', 'pay_OTHER', secret), good), false);
    assert.equal(safeEqualHex(checkoutSignature('order_ABC', 'pay_XYZ', 'wrong'), good), false);
    assert.equal(safeEqualHex(good, good), true);
  });

  it('webhook signature covers the exact raw body', () => {
    const body = Buffer.from('{"event":"payment.captured"}');
    const sig = webhookSignature(body, secret);
    assert.ok(safeEqualHex(webhookSignature(Buffer.from('{"event":"payment.captured"}'), secret), sig));
    assert.equal(safeEqualHex(webhookSignature(Buffer.from('{"event": "payment.captured"}'), secret), sig), false, 'whitespace changes break it');
  });

  it('length mismatch never throws', () => assert.equal(safeEqualHex('abc', 'abcd'), false));
});
