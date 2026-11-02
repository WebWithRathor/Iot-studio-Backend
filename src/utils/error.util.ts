import { ERROR_CODES, type ErrorCode } from '../constants/error-codes.constants';

/**
 * Typed application error. `expose` controls whether `message`/`details`
 * reach the client; unexpected errors are always replaced with a generic
 * message by the error middleware.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly expose = true,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, ERROR_CODES.BAD_REQUEST, message, details);
export const validationError = (message: string, details?: unknown) => new AppError(400, ERROR_CODES.VALIDATION_ERROR, message, details);
export const unsafeInput = (message: string) => new AppError(400, ERROR_CODES.UNSAFE_INPUT, message);
export const unauthenticated = (message = 'Sign in to continue.', code: ErrorCode = ERROR_CODES.UNAUTHENTICATED) => new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to do that.', code: ErrorCode = ERROR_CODES.FORBIDDEN) => new AppError(403, code, message);
/** Used for resources the caller does not own too — never reveal that someone else's record exists. */
export const notFound = (what = 'Resource') => new AppError(404, ERROR_CODES.NOT_FOUND, `${what} not found.`);
export const conflict = (message: string, code: ErrorCode = ERROR_CODES.CONFLICT, details?: unknown) => new AppError(409, code, message, details);
export const limitReached = (message: string) => new AppError(409, ERROR_CODES.LIMIT_REACHED, message);
/** 402 Payment Required: the action needs more tokens than the account has left. */
export const insufficientTokens = (message: string, details: { required: number; available: number; plan: string }) =>
  new AppError(402, ERROR_CODES.INSUFFICIENT_TOKENS, message, details);
export const tooManyRequests = (message = 'Too many requests. Try again shortly.') => new AppError(429, ERROR_CODES.RATE_LIMITED, message);
export const serviceUnavailable = (code: ErrorCode, message: string) => new AppError(503, code, message);
export const unsupported = (message: string) => new AppError(400, ERROR_CODES.UNSUPPORTED_OPERATION, message);

/** Category used in logs and error mapping for database failures. Never includes query contents. */
export type DbErrorCategory = 'duplicate_key' | 'cast' | 'validation' | 'unavailable' | 'timeout' | 'write_conflict' | 'unknown';

export function classifyDbError(err: unknown): DbErrorCategory {
  const e = err as { name?: string; code?: number; message?: string; errorLabels?: string[] } | null;
  if (!e) return 'unknown';
  if (e.code === 11000 || e.code === 11001) return 'duplicate_key';
  if (e.name === 'CastError') return 'cast';
  if (e.name === 'ValidationError') return 'validation';
  if (e.code === 112 || e.errorLabels?.includes('TransientTransactionError')) return 'write_conflict';
  if (
    e.name === 'MongoServerSelectionError' ||
    e.name === 'MongoNotConnectedError' ||
    e.name === 'MongoNetworkError' ||
    e.name === 'MongoTopologyClosedError' ||
    /buffering timed out|client must be connected|connection .* closed/i.test(e.message ?? '')
  )
    return 'unavailable';
  if (e.name === 'MongoNetworkTimeoutError' || e.code === 50) return 'timeout';
  return 'unknown';
}

/** Map arbitrary thrown values to an AppError for the HTTP layer. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const category = classifyDbError(err);
  switch (category) {
    case 'duplicate_key': {
      const keys = Object.keys((err as { keyPattern?: Record<string, unknown> }).keyPattern ?? {});
      return conflict('A record with the same unique value already exists.', ERROR_CODES.DUPLICATE, keys.length ? { fields: keys } : undefined);
    }
    case 'cast':
      return badRequest('An identifier in the request is malformed.');
    case 'validation':
      return validationError('The record failed database validation.');
    case 'unavailable':
    case 'timeout':
      return serviceUnavailable(ERROR_CODES.DATABASE_UNAVAILABLE, 'The database is unavailable. Try again shortly.');
    case 'write_conflict':
      return conflict('The record was changed by another request. Retry.');
  }
  const e = err as { name?: string; message?: string; type?: string; status?: number } | null;
  if (e?.name === 'MaxRetriesPerRequestError' || /Connection is closed|Stream isn't writeable|enableOfflineQueue/i.test(e?.message ?? '')) {
    return serviceUnavailable(ERROR_CODES.CACHE_UNAVAILABLE, 'The session store is unavailable. Try again shortly.');
  }
  // body-parser errors
  if (e?.type === 'entity.too.large') return new AppError(413, ERROR_CODES.PAYLOAD_TOO_LARGE, 'The request body is too large.');
  if (e?.type === 'entity.parse.failed') return new AppError(400, ERROR_CODES.INVALID_JSON, 'The request body is not valid JSON.');
  return new AppError(500, ERROR_CODES.INTERNAL_ERROR, 'Something went wrong on our side.', undefined, false);
}
