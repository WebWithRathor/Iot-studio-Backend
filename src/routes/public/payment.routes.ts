import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.constants';
import { paymentController } from '../../controllers/public/payment.controller';
import { authenticate } from '../../middleware/authenticate.middleware';
import { authorizePermission } from '../../middleware/authorize-permission.middleware';
import { paymentLimiter } from '../../middleware/rate-limit.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { cancelPaymentBody, createOrderBody, mockCompleteBody, verifyPaymentBody } from '../../validations/public/payment.validation';

/** /payments — the signed-in user's purchases. The gateway webhook is mounted separately in app.ts (raw body, no cookies). */
export const paymentRoutes = Router();
paymentRoutes.use(authenticate);

paymentRoutes.get('/catalog', authorizePermission(P.PROFILE_READ), paymentController.catalog);
paymentRoutes.get('/', authorizePermission(P.PROFILE_READ), paymentController.history);
paymentRoutes.post('/orders', authorizePermission(P.PROFILE_UPDATE), paymentLimiter(), validateRequest({ body: createOrderBody }), paymentController.createOrder);
paymentRoutes.post('/verify', authorizePermission(P.PROFILE_UPDATE), paymentLimiter(), validateRequest({ body: verifyPaymentBody }), paymentController.verify);
paymentRoutes.post('/mock/complete', authorizePermission(P.PROFILE_UPDATE), paymentLimiter(), validateRequest({ body: mockCompleteBody }), paymentController.completeMock);
paymentRoutes.post('/cancel', authorizePermission(P.PROFILE_UPDATE), validateRequest({ body: cancelPaymentBody }), paymentController.cancel);
