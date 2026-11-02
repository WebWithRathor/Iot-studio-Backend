import type { NextFunction, Request, Response } from 'express';
import { authService } from '../services/public/auth.service';
import { cookieService } from '../services/shared/cookie.service';
import { unauthenticated } from '../utils/error.util';
import { getContext } from '../utils/logger.util';

/**
 * Requires a valid access-token cookie. Attaches `req.user`.
 * Expired → 401 TOKEN_EXPIRED (the frontend then calls /auth/refresh once).
 * Revoked session / changed permissions / disabled account → 401 and the
 * user must sign in again. Redis down → 503 (fails closed).
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  if (req.user) return next(); // already authenticated by an outer router
  const token = cookieService.readAccessToken(req);
  if (!token) return next(unauthenticated());
  authService
    .resolveAccessToken(token)
    .then((user) => {
      req.user = user;
      const ctx = getContext();
      ctx.userId = user.id;
      next();
    })
    .catch(next);
}
