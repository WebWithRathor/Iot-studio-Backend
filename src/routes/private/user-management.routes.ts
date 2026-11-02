import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.constants';
import { userManagementController } from '../../controllers/private/user-management.controller';
import { authorizePermission } from '../../middleware/authorize-permission.middleware';
import { heavyLimiter } from '../../middleware/rate-limit.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { emptyBody } from '../../validations/public/auth.validation';
import { changePlanBody, changeRoleBody, changeStatusBody, listUsersQuery } from '../../validations/private/user-management.validation';
import { idParams } from '../../validations/shared/common.validation';

export const userManagementRoutes = Router();
userManagementRoutes.get('/', authorizePermission(P.USERS_READ), heavyLimiter(), validateRequest({ query: listUsersQuery }), userManagementController.list);
userManagementRoutes.get('/:id', authorizePermission(P.USERS_READ), validateRequest({ params: idParams }), userManagementController.get);
userManagementRoutes.get('/:id/sessions', authorizePermission(P.USERS_MANAGE), validateRequest({ params: idParams }), userManagementController.sessions);
userManagementRoutes.patch('/:id/role', authorizePermission(P.USERS_ROLE_CHANGE), validateRequest({ params: idParams, body: changeRoleBody }), userManagementController.changeRole);
userManagementRoutes.patch('/:id/plan', authorizePermission(P.PLANS_MANAGE), validateRequest({ params: idParams, body: changePlanBody }), userManagementController.changePlan);
userManagementRoutes.patch('/:id/status', authorizePermission(P.USERS_MANAGE), validateRequest({ params: idParams, body: changeStatusBody }), userManagementController.changeStatus);
userManagementRoutes.post('/:id/sessions/revoke', authorizePermission(P.USERS_MANAGE), validateRequest({ params: idParams, body: emptyBody }), userManagementController.revokeSessions);
