import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Request signing for the LMS → IoT Studio API (contract B, docs/LMS-INTEGRATION.md):
 *
 *   X-Kokoon-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + METHOD + "." + pathWithQuery + "." + rawBody)>
 *
 * `pathWithQuery` is the path exactly as it appears in the HTTP request line,
 * including the API base path, e.g. `/api/v1/integrations/lms/devices/kk-esp32s3-7f3k9q2m?rotateCredentials=true`.
 */

export const LMS_HEADERS = {
  TIMESTAMP: 'x-kokoon-timestamp',
  REQUEST_ID: 'x-kokoon-request-id',
  SIGNATURE: 'x-kokoon-signature',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const signingInput = (timestamp: string, method: string, pathWithQuery: string, rawBody: Buffer | string) =>
  Buffer.concat([Buffer.from(`${timestamp}.${method.toUpperCase()}.${pathWithQuery}.`, 'utf8'), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8')]);

/** `sha256=<hex>` for a request. Used by the verifier and by `npm run lms:device`. */
export function signLmsRequest(secret: string, timestamp: string, method: string, pathWithQuery: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(signingInput(timestamp, method, pathWithQuery, rawBody)).digest('hex')}`;
}

export type SignatureProblem = 'missing_headers' | 'bad_request_id' | 'stale_timestamp' | 'invalid_signature';

/** Pure check of the three signing headers. Returns the problem, or null when the request is authentic and fresh. */
export function checkLmsSignature(input: {
  secret: string;
  timestamp: string | undefined;
  requestId: string | undefined;
  signature: string | undefined;
  method: string;
  pathWithQuery: string;
  rawBody: Buffer;
  maxSkewSec: number;
  nowSec?: number;
}): SignatureProblem | null {
  const { timestamp, requestId, signature } = input;
  if (!input.secret || !timestamp || !requestId || !signature) return 'missing_headers';
  if (!UUID.test(requestId)) return 'bad_request_id';
  if (!/^\d{9,11}$/.test(timestamp)) return 'stale_timestamp';
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > input.maxSkewSec) return 'stale_timestamp';
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signature.trim());
  if (!m) return 'invalid_signature';
  const expected = Buffer.from(signLmsRequest(input.secret, timestamp, input.method, input.pathWithQuery, input.rawBody).slice(7), 'hex');
  const given = Buffer.from(m[1]!.toLowerCase(), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected) ? null : 'invalid_signature';
}

/** Hash of the raw body, stored with an idempotency key to detect a reused Request-Id with a different body. */
export const bodyHash = (method: string, pathWithQuery: string, rawBody: Buffer) =>
  createHash('sha256').update(signingInput('', method, pathWithQuery, rawBody)).digest('hex');
