import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { loadEnv } from '../config/env.config';
import { lmsConfig } from '../config/lms.config';
import { redisKeys } from '../config/redis.config';
import { ERROR_CODES } from '../constants/error-codes.constants';
import { redisService } from '../services/shared/redis.service';
import { buildFailure } from '../utils/api-response.util';
import { LmsApiError } from '../utils/lms-api-error.util';

/**
 * Redis-backed rate limits (shared across instances). If Redis is down the
 * limiter errors and the request fails with 503 — limits are not silently
 * dropped (passOnStoreError=false).
 */

function store(name: string) {
  return new RedisStore({
    prefix: redisKeys.rateLimit(name),
    sendCommand: (command: string, ...args: string[]) => redisService.raw().call(command, ...args) as Promise<RedisReply>,
  });
}

function handler(message: string): Options['handler'] {
  return (req: Request, res: Response) => {
    res.status(429).json(buildFailure(req.requestId, ERROR_CODES.RATE_LIMITED, message));
  };
}

function limiter(name: string, opts: Partial<Options> & { message: string }): RequestHandler {
  let instance: RequestHandler | null = null;
  // Created lazily so the Redis connection exists by the first request.
  return (req, res, next) => {
    instance ??= rateLimit({
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      passOnStoreError: false,
      // Lazy creation inside the handler is intentional (see above).
      validate: { creationStack: false },
      store: store(name),
      handler: handler(opts.message),
      ...opts,
    });
    return instance(req, res, next);
  };
}

const userOrIp = (req: Request) => (req.user ? `u:${req.user.id}` : `ip:${req.ip}`);

export const generalLimiter = () => {
  const e = loadEnv();
  return limiter('general', { windowMs: e.RATE_LIMIT_WINDOW_MS, limit: e.RATE_LIMIT_MAX_REQUESTS, message: 'Too many requests. Slow down and try again shortly.' });
};

/** Login / register: per IP + email, to slow credential stuffing. */
export const authLimiter = () => {
  const e = loadEnv();
  return limiter('auth', {
    windowMs: 15 * 60_000,
    limit: e.AUTH_RATE_LIMIT_MAX_REQUESTS,
    keyGenerator: (req) => `${req.ip}:${typeof req.body?.email === 'string' ? req.body.email.toLowerCase().slice(0, 254) : ''}`,
    message: 'Too many sign-in attempts. Wait 15 minutes and try again.',
  });
};

export const refreshLimiter = () => limiter('refresh', { windowMs: 15 * 60_000, limit: 60, message: 'Too many session refreshes. Sign in again.' });

/** Device commands: per user, 10-second window. */
export const commandLimiter = () => {
  const e = loadEnv();
  return limiter('command', { windowMs: 10_000, limit: e.COMMAND_RATE_LIMIT_PER_10S, keyGenerator: userOrIp, message: 'You are sending commands too quickly. Wait a few seconds.' });
};

/** Kit code redemption: per user, 10 attempts per 15 minutes. */
export const redeemLimiter = () => limiter('redeem', { windowMs: 15 * 60_000, limit: 10, keyGenerator: userOrIp, message: 'Too many kit code attempts. Wait 15 minutes and try again.' });

/** Checkout actions: per user, 20 per 10 minutes. */
export const paymentLimiter = () => limiter('payment', { windowMs: 10 * 60_000, limit: 20, keyGenerator: userOrIp, message: 'Too many payment attempts. Wait a few minutes and try again.' });

/** Expensive reads (telemetry history, exports, admin listings). */
export const heavyLimiter = () => limiter('heavy', { windowMs: 60_000, limit: 60, keyGenerator: userOrIp, message: 'Too many heavy requests. Try again in a minute.' });

/** "Sign in with Kokoon LMS" form posts: per IP. */
export const lmsSsoLimiter = () =>
  limiter('lms-sso', {
    windowMs: 15 * 60_000,
    limit: 60,
    message: 'Too many sign-in attempts from the LMS. Wait a few minutes and try again.',
    // A browser navigation, not an API call: land on the login page instead of raw JSON.
    handler: (_req: Request, res: Response) => res.redirect(303, `${loadEnv().FRONTEND_URL.replace(/\/+$/, '')}/#/login?sso_error=unavailable`),
  });

/*
 * LMS → IoT Studio server-to-server API. The signature is verified first (a
 * cheap HMAC); then:
 *   lmsApiUnsignedLimiter — requests that FAILED the check, per IP (600/min)
 *   lmsApiCallerLimiter   — verified requests, one bucket for the caller (the LMS
 *                           backend, however many IPs it uses), LMS_API_RATE_LIMIT_PER_MIN
 * The limiter sets Retry-After from the window's reset time; lmsErrorHandler keeps it.
 */

/** Pure: did verifyLmsSignature accept this request? */
export const isVerifiedLmsCall = (res: Response): boolean => Boolean((res.locals as { lms?: unknown }).lms);

/** Everyone holding LMS_API_SECRET is the same caller. */
export const lmsCallerKey = (): string => 'lms';

const lmsRateLimited = (_req: Request, _res: Response, next: NextFunction) => next(new LmsApiError(429, 'rate_limited', 'Too many requests from the LMS. Slow down and retry after Retry-After seconds.'));

export const lmsApiUnsignedLimiter = () =>
  limiter('lms-api', {
    windowMs: 60_000,
    limit: lmsConfig().apiUnsignedRateLimitPerMin,
    skip: (_req: Request, res: Response) => isVerifiedLmsCall(res),
    message: 'Too many unsigned requests. Slow down and retry.',
    handler: lmsRateLimited,
  });

export const lmsApiCallerLimiter = () =>
  limiter('lms-api-caller', {
    windowMs: 60_000,
    limit: lmsConfig().apiRateLimitPerMin,
    keyGenerator: lmsCallerKey,
    message: 'Too many requests from the LMS. Slow down and retry.',
    handler: lmsRateLimited,
  });
