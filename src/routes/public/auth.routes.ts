import { Router } from 'express';
import { authController } from '../../controllers/public/auth.controller';
import { authenticate } from '../../middleware/authenticate.middleware';
import { authLimiter, refreshLimiter } from '../../middleware/rate-limit.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { emptyBody, loginBody, registerBody } from '../../validations/public/auth.validation';

/**
 * Auth policies:
 *   GET  /auth/config    anonymous
 *   POST /auth/register  anonymous, rate-limited, disabled by REGISTRATION_ENABLED=false
 *   POST /auth/login     anonymous, rate-limited
 *   POST /auth/refresh   refresh cookie only (path-scoped to /auth), rate-limited
 *   POST /auth/logout    any (revokes whatever session the cookies identify)
 *   GET  /auth/me        authenticated
 */
export const authRoutes = Router();

authRoutes.get('/config', authController.config);
authRoutes.post('/register', authLimiter(), validateRequest({ body: registerBody }), authController.register);
authRoutes.post('/login', authLimiter(), validateRequest({ body: loginBody }), authController.login);
authRoutes.post('/refresh', refreshLimiter(), validateRequest({ body: emptyBody }), authController.refresh);
authRoutes.post('/logout', validateRequest({ body: emptyBody }), authController.logout);
authRoutes.get('/me', authenticate, authController.me);
