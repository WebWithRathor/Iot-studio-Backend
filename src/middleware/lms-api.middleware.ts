import type { NextFunction, Request, Response } from 'express';
import { lmsConfig } from '../config/lms.config';
import { auditLogService } from '../services/private/audit-log.service';
import { encryptionService } from '../services/shared/encryption.service';
import { redisService } from '../services/shared/redis.service';
import { LmsApiError, toLmsApiError } from '../utils/lms-api-error.util';
import { LMS_HEADERS, bodyHash, checkLmsSignature } from '../utils/lms-signature.util';
import { channel } from '../utils/logger.util';

/**
 * LMS → IoT Studio API guards (contract B, docs/LMS-INTEGRATION.md), in order:
 *   lmsEnabled → verifyLmsSignature (HMAC over the raw body, ±300 s)
 *   → per-IP limiter for failed checks → rejectUnverifiedLms → per-caller limiter
 *   → lmsIdempotency (X-Kokoon-Request-Id, 24 h, responses stored encrypted; writes only)
 * plus the router-level 404 and error handler that answer in the contract's error shape.
 */

export interface LmsRequestState {
  requestId: string;
  rawBody: Buffer;
  /** Set when this request reserved its idempotency key and must store its response. */
  idempotency?: { hash: string };
}

interface IdempotencyRecord {
  state: 'pending' | 'done';
  hash: string;
  status?: number;
  body?: unknown;
}

export const lmsState = (res: Response): LmsRequestState => res.locals.lms as LmsRequestState;

const rawBodyOf = (req: Request): Buffer => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));

export function lmsEnabled(_req: Request, _res: Response, next: NextFunction): void {
  if (!lmsConfig().enabled) return next(new LmsApiError(503, 'integration_disabled', 'The LMS integration is turned off on this IoT Studio server.'));
  next();
}

/**
 * Checks the HMAC and remembers the verdict WITHOUT failing yet, so the
 * per-IP limiter can count only bad requests; rejectUnverifiedLms answers 401.
 */
export function verifyLmsSignature(req: Request, res: Response, next: NextFunction): void {
  const cfg = lmsConfig();
  const rawBody = rawBodyOf(req);
  const requestId = req.get(LMS_HEADERS.REQUEST_ID);
  const problem = checkLmsSignature({
    secret: cfg.apiSecret,
    timestamp: req.get(LMS_HEADERS.TIMESTAMP),
    requestId,
    signature: req.get(LMS_HEADERS.SIGNATURE),
    method: req.method,
    pathWithQuery: req.originalUrl,
    rawBody,
    maxSkewSec: cfg.apiMaxSkewSec,
  });
  if (problem) {
    res.locals.lmsRejection =
      problem === 'stale_timestamp'
        ? new LmsApiError(401, 'stale_timestamp', 'X-Kokoon-Timestamp is missing, malformed or more than 300 s away from the server clock.')
        : new LmsApiError(401, 'invalid_signature', problem === 'invalid_signature' ? 'The request signature does not match.' : 'X-Kokoon-Timestamp, X-Kokoon-Request-Id (UUID) and X-Kokoon-Signature are required.');
    res.locals.lmsRejectionReason = problem;
    return next();
  }
  res.locals.lms = { requestId: requestId!, rawBody } satisfies LmsRequestState;
  next();
}

/** 401 for a request verifyLmsSignature did not accept (after the per-IP limiter counted it). */
export function rejectUnverifiedLms(req: Request, res: Response, next: NextFunction): void {
  if (res.locals.lms) return next();
  const reason = (res.locals.lmsRejectionReason as string | undefined) ?? 'missing_headers';
  void auditLogService.record({ action: 'lms.api.rejected', outcome: 'denied', ip: req.ip, metadata: { reason, method: req.method, path: req.path } }).catch(() => undefined);
  next((res.locals.lmsRejection as LmsApiError | undefined) ?? new LmsApiError(401, 'invalid_signature', 'X-Kokoon-Timestamp, X-Kokoon-Request-Id (UUID) and X-Kokoon-Signature are required.'));
}

/** Writes are idempotent per X-Kokoon-Request-Id: same id + same body → the stored response; different body → 422. */
export async function lmsIdempotency(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const cfg = lmsConfig();
  const state = lmsState(res);
  const hash = bodyHash(req.method, req.originalUrl, state.rawBody);
  try {
    const pending: IdempotencyRecord = { state: 'pending', hash };
    const existing = await redisService.reserveIdempotency(state.requestId, encryptionService.encryptJson(pending), cfg.idempotencyPendingTtlSec);
    if (existing === null) {
      state.idempotency = { hash };
      return next();
    }
    // '' = the reservation expired between SET NX and GET: let the caller retry.
    if (existing === '') return next(new LmsApiError(503, 'request_in_progress', 'A request with this X-Kokoon-Request-Id is still being processed. Retry shortly.'));
    const rec = encryptionService.decryptJson<IdempotencyRecord>(existing);
    if (!rec || rec.hash !== hash) return next(new LmsApiError(422, 'validation_failed', 'X-Kokoon-Request-Id was already used for a different request. Use a new UUID for every new request.'));
    if (rec.state === 'pending') return next(new LmsApiError(503, 'request_in_progress', 'A request with this X-Kokoon-Request-Id is still being processed. Retry shortly.'));
    res.set('X-Kokoon-Idempotent-Replay', 'true');
    if (rec.status === 204 || rec.body === undefined) {
      res.status(rec.status ?? 204).end();
      return;
    }
    res.status(rec.status ?? 200).json(rec.body);
  } catch (err) {
    next(err);
  }
}

/** Send a success response and remember it for idempotent retries. */
export async function sendLms(res: Response, status: number, body?: unknown): Promise<void> {
  const state = lmsState(res);
  if (state?.idempotency) {
    const rec: IdempotencyRecord = { state: 'done', hash: state.idempotency.hash, status, body };
    await redisService.storeIdempotency(state.requestId, encryptionService.encryptJson(rec), lmsConfig().idempotencyTtlSec).catch((err) => {
      channel('app').warn('lms.idempotency.store.failed', { errorName: (err as Error).name });
    });
  }
  if (body === undefined) res.status(status).end();
  else res.status(status).json(body);
}

export function lmsNotFound(req: Request, _res: Response, next: NextFunction): void {
  next(new LmsApiError(404, 'not_found', `No LMS integration endpoint ${req.method} ${req.path}.`));
}

export function lmsErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const e = toLmsApiError(err);
  const state = lmsState(res);
  // A failed request must not block a retry with the same Request-Id.
  if (state?.idempotency) void redisService.releaseIdempotency(state.requestId).catch(() => undefined);
  const level = e.status >= 500 ? 'error' : 'warn';
  channel('app')[level]('lms.api.error', { code: e.code, status: e.status, method: req.method, path: req.path, ...(e.status >= 500 && !(err instanceof LmsApiError) ? { errorName: (err as Error)?.name } : {}) });
  // A 429 from the limiter already carries Retry-After = seconds until its window resets.
  if ((e.status === 429 || e.code === 'request_in_progress') && !res.get('Retry-After')) res.set('Retry-After', '2');
  res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) }, requestId: req.requestId });
}
