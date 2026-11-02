import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.constants';
import { userController } from '../../controllers/public/user.controller';
import { authenticate } from '../../middleware/authenticate.middleware';
import { authorizePermission } from '../../middleware/authorize-permission.middleware';
import { authLimiter, redeemLimiter } from '../../middleware/rate-limit.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { emptyBody } from '../../validations/public/auth.validation';
import { activityQuery, changePasswordBody, redeemKitBody, updatePreferencesBody, updateProfileBody } from '../../validations/public/user.validation';

export const userRoutes = Router();
userRoutes.use(authenticate);

userRoutes.get('/me', authorizePermission(P.PROFILE_READ), userController.me);
userRoutes.patch('/me', authorizePermission(P.PROFILE_UPDATE), validateRequest({ body: updateProfileBody }), userController.updateProfile);
userRoutes.patch('/me/preferences', authorizePermission(P.PROFILE_UPDATE), validateRequest({ body: updatePreferencesBody }), userController.updatePreferences);
userRoutes.post('/me/password', authorizePermission(P.PROFILE_UPDATE), authLimiter(), validateRequest({ body: changePasswordBody }), userController.changePassword);
userRoutes.get('/me/workspace', authorizePermission(P.PROJECT_READ), userController.workspace);
userRoutes.get('/me/tokens', authorizePermission(P.PROJECT_READ), userController.tokens);
// Kit codes can only be guessed by brute force: tight per-user limit.
userRoutes.post('/me/redeem-kit', authorizePermission(P.PROFILE_UPDATE), redeemLimiter(), validateRequest({ body: redeemKitBody }), userController.redeemKit);
userRoutes.get('/me/activity', authorizePermission(P.ACTIVITY_READ), validateRequest({ query: activityQuery }), userController.activity);
userRoutes.post('/me/demo-workspace/reset', authorizePermission(P.DEMO_RESET), validateRequest({ body: emptyBody }), userController.resetDemo);
