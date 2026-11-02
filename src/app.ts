import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { allowedOrigins, loadEnv } from './config/env.config';
import { helmetConfig } from './config/helmet.config';
import { CSRF_HEADER } from './constants/cookie.constants';
import { LIMITS } from './constants/app.constants';
import { authController } from './controllers/public/auth.controller';
import { paymentController } from './controllers/public/payment.controller';
import { csrfProtection } from './middleware/csrf.middleware';
import { errorHandler } from './middleware/error.middleware';
import { notFoundHandler } from './middleware/not-found.middleware';
import { lmsSsoLimiter } from './middleware/rate-limit.middleware';
import { querySanitization } from './middleware/query-sanitization.middleware';
import { requestLogger } from './middleware/request-logger.middleware';
import { buildRouter } from './routes/index.routes';
import { lmsIntegrationRoutes } from './routes/integrations/lms.routes';
import { forbidden } from './utils/error.util';

/**
 * Middleware order (security-relevant):
 *   request id + logging → helmet → [LMS SSO form: urlencoded → signed one-time token]
 *   → CORS → cookies → [LMS API: raw body → HMAC signature → idempotency] → JSON body (size-limited)
 *   → query/body sanitisation → CSRF → rate limit (in router) → routes
 *   (authenticate → authorise → validate → controller) → 404 → error handler
 */
export function createApp(): Express {
  const env = loadEnv();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  // 'simple' = node:querystring — no nested objects like ?a[$ne]=1
  app.set('query parser', 'simple');
  app.set('etag', false);

  app.use(requestLogger);
  app.use(helmet(helmetConfig()));
  // "Sign in with Kokoon LMS" (docs/LMS-INTEGRATION.md): a top-level form POST from the LMS origin,
  // authenticated by a one-time signed token and checked against LMS_URL's origin in the service.
  // Mounted before CORS (the LMS is not an allowed API origin) and the X-Requested-With CSRF rule.
  app.post(`${env.API_BASE_PATH}/auth/lms/sso`, lmsSsoLimiter(), express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 10 }), authController.lmsSso);
  const origins = allowedOrigins();
  app.use(
    cors({
      origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
        // No Origin header: same-origin, curl, health checks — allowed (cookies still required for data).
        if (!origin || origins.includes(origin)) return cb(null, true);
        cb(forbidden('Origin not allowed.'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', CSRF_HEADER, 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use(cookieParser());
  // Payment gateway webhook: server-to-server, authenticated by an HMAC of the RAW body,
  // so it must be mounted before the JSON parser and the browser-oriented CSRF check.
  app.post(`${env.API_BASE_PATH}/payments/webhook/razorpay`, express.raw({ type: 'application/json', limit: LIMITS.JSON_BODY }), paymentController.webhook);
  // Kokoon LMS server-to-server API (docs/LMS-INTEGRATION.md): signed over the RAW body,
  // so it is mounted before the JSON parser and the browser-oriented CSRF check.
  app.use(`${env.API_BASE_PATH}/integrations/lms`, express.raw({ type: '*/*', limit: LIMITS.JSON_BODY }), lmsIntegrationRoutes());
  app.use(express.json({ limit: LIMITS.JSON_BODY, strict: true, type: 'application/json' }));
  app.use(querySanitization);
  app.use(csrfProtection);

  app.use(env.API_BASE_PATH, buildRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
