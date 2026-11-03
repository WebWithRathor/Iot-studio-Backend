import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.constants';
import { adminController } from '../../controllers/private/admin.controller';
import { authorizePermission } from '../../middleware/authorize-permission.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { appSettingsBody, overviewQuery } from '../../validations/private/admin.validation';
import { emptyBody } from '../../validations/public/auth.validation';

/** Mounted under /admin, which is already fenced by authenticate + authorizeRole(ADMIN). */
export const adminRoutes = Router();
adminRoutes.get('/overview', authorizePermission(P.ADMIN_OVERVIEW), validateRequest({ query: overviewQuery }), adminController.overview);
adminRoutes.get('/metrics/db', authorizePermission(P.ADMIN_OVERVIEW), adminController.dbMetrics);
adminRoutes.get('/settings', authorizePermission(P.PLANS_MANAGE), adminController.settings);
adminRoutes.patch('/settings', authorizePermission(P.PLANS_MANAGE), validateRequest({ body: appSettingsBody }), adminController.updateSettings);
adminRoutes.post('/metrics/db/reset', authorizePermission(P.ADMIN_OVERVIEW), validateRequest({ body: emptyBody }), adminController.resetDbMetrics);
