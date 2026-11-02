import type { NextFunction, Request, Response } from 'express';
import { isProduction } from '../config/env.config';
import { buildFailure } from '../utils/api-response.util';
import { toAppError } from '../utils/error.util';
import { channel } from '../utils/logger.util';
import { redactString } from '../utils/redact.util';

/**
 * Centralised error handler. Logs the underlying error safely (with the
 * request id) and returns `{ success:false, error:{code,message,details?}, requestId }`.
 * Unexpected errors never leak messages or stack traces to the client.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const appErr = toAppError(err);
  const raw = err as Error;
  const meta = {
    requestId: req.requestId,
    code: appErr.code,
    status: appErr.status,
    method: req.method,
    path: req.baseUrl + req.path,
    userId: req.user?.id,
    errorName: raw?.name,
    error: raw?.message ? redactString(raw.message) : undefined,
    stack: appErr.status >= 500 && !isProduction() ? raw?.stack?.split('\n').slice(0, 6).join(' | ') : undefined,
  };
  if (appErr.status >= 500) channel('app').error('request.failed', meta);
  else channel('app').warn('request.rejected', { requestId: meta.requestId, code: meta.code, status: meta.status, path: meta.path, userId: meta.userId });

  if (res.headersSent) {
    res.end();
    return;
  }
  const message = appErr.expose ? appErr.message : 'Something went wrong on our side. Please try again.';
  res.status(appErr.status).json(buildFailure(req.requestId, appErr.code, message, appErr.expose ? appErr.details : undefined));
}
