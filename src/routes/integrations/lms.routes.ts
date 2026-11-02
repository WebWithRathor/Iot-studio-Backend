import { Router } from 'express';
import { lmsController } from '../../controllers/integrations/lms.controller';
import { lmsEnabled, lmsErrorHandler, lmsIdempotency, lmsNotFound, rejectUnverifiedLms, verifyLmsSignature } from '../../middleware/lms-api.middleware';
import { lmsApiCallerLimiter, lmsApiUnsignedLimiter } from '../../middleware/rate-limit.middleware';

/**
 * Kokoon LMS server-to-server API, mounted at {API_BASE_PATH}/integrations/lms
 * in app.ts (raw body, before the JSON parser and the browser CSRF check).
 * No cookies: every request is authenticated by its HMAC signature.
 *
 *   PUT    /devices/:hardwareId   upsert a board flashed from the LMS (B1)
 *   GET    /devices/:hardwareId   its connection state and projects (B2)
 *   POST   /devices/status        connection state of up to 200 boards (bulk B2, read-only)
 *   DELETE /devices/:hardwareId   disable it and revoke its broker access (B3)
 *
 * Rate limits: requests failing the signature check per IP; verified ones per caller.
 */
export function lmsIntegrationRoutes(): Router {
  const r = Router();
  r.use(lmsEnabled, verifyLmsSignature, lmsApiUnsignedLimiter(), rejectUnverifiedLms, lmsApiCallerLimiter());
  // Read-only POST: registered before the idempotency guard so it is never stored.
  r.post('/devices/status', lmsController.devicesStatus);
  r.use(lmsIdempotency);
  r.put('/devices/:hardwareId', lmsController.upsertDevice);
  r.get('/devices/:hardwareId', lmsController.getDevice);
  r.delete('/devices/:hardwareId', lmsController.disableDevice);
  r.use(lmsNotFound);
  r.use(lmsErrorHandler);
  return r;
}
