import type { NextFunction, Request, Response } from 'express';
import { allowedOrigins } from '../config/env.config';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../constants/cookie.constants';
import { ERROR_CODES } from '../constants/error-codes.constants';
import { forbidden } from '../utils/error.util';

/**
 * CSRF protection for cookie authentication (defence in depth with SameSite):
 *   1. Every state-changing request must carry `X-Requested-With: XMLHttpRequest`.
 *      A cross-site <form> or simple fetch cannot set custom headers, and a
 *      cross-origin fetch that does triggers a CORS preflight that only the
 *      configured frontend origin passes.
 *   2. If the browser sends an Origin header it must be an allowed origin.
 * Safe methods (GET/HEAD/OPTIONS) are exempt and never change state.
 */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE.has(req.method)) return next();
  if (req.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) return next(forbidden('Request blocked by CSRF protection.', ERROR_CODES.CSRF_REJECTED));
  const origin = req.get('origin');
  if (origin && !allowedOrigins().includes(origin)) return next(forbidden('Request blocked: unknown origin.', ERROR_CODES.CSRF_REJECTED));
  next();
}
