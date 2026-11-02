import { ERROR_CODES } from '../constants/error-codes.constants';
import { AppError, toAppError } from './error.util';

/**
 * Errors of the LMS → IoT Studio API use the contract's snake_case codes
 * (docs/LMS-INTEGRATION.md, contract B), not the app's UPPER_CASE codes:
 *   { "error": { "code": "device_owned_by_other_user", "message": "…" }, "requestId": "…" }
 */
export type LmsApiErrorCode =
  | 'invalid_signature'
  | 'stale_timestamp'
  | 'validation_failed'
  | 'device_owned_by_other_user'
  | 'user_disabled'
  | 'not_found'
  | 'integration_disabled'
  /** chipId binding (409): this hardware id is on another chip / this chip is another active device. */
  | 'chip_mismatch'
  | 'chip_in_use'
  /** Additions to the contract: retry these (5xx / 429). */
  | 'request_in_progress'
  | 'rate_limited'
  | 'unavailable'
  | 'internal_error';

export class LmsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: LmsApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'LmsApiError';
  }
}

/** Map anything thrown inside the LMS API to the contract's error shape. */
export function toLmsApiError(err: unknown): LmsApiError {
  if (err instanceof LmsApiError) return err;
  const e: AppError = toAppError(err);
  switch (e.code) {
    case ERROR_CODES.VALIDATION_ERROR:
    case ERROR_CODES.BAD_REQUEST:
    case ERROR_CODES.INVALID_JSON:
    case ERROR_CODES.UNSAFE_INPUT:
    case ERROR_CODES.TOPIC_NOT_ALLOWED:
    case ERROR_CODES.LIMIT_REACHED:
    case ERROR_CODES.DUPLICATE:
      return new LmsApiError(422, 'validation_failed', e.message, e.details);
    case ERROR_CODES.PAYLOAD_TOO_LARGE:
      return new LmsApiError(413, 'validation_failed', e.message);
    case ERROR_CODES.NOT_FOUND:
      return new LmsApiError(404, 'not_found', e.message);
    case ERROR_CODES.RATE_LIMITED:
      return new LmsApiError(429, 'rate_limited', e.message);
    case ERROR_CODES.DATABASE_UNAVAILABLE:
    case ERROR_CODES.CACHE_UNAVAILABLE:
    case ERROR_CODES.MQTT_UNAVAILABLE:
      return new LmsApiError(503, 'unavailable', e.message);
    default:
      return new LmsApiError(500, 'internal_error', e.expose && e.status < 500 ? e.message : 'Something went wrong on our side.');
  }
}
