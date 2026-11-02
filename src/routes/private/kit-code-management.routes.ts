import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.constants';
import { kitCodeManagementController } from '../../controllers/private/kit-code-management.controller';
import { authorizePermission } from '../../middleware/authorize-permission.middleware';
import { heavyLimiter } from '../../middleware/rate-limit.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { generateKitCodesBody, listKitCodesQuery } from '../../validations/private/kit-code.validation';

export const kitCodeManagementRoutes = Router();
kitCodeManagementRoutes.get('/', authorizePermission(P.PLANS_MANAGE), heavyLimiter(), validateRequest({ query: listKitCodesQuery }), kitCodeManagementController.list);
kitCodeManagementRoutes.post('/', authorizePermission(P.PLANS_MANAGE), validateRequest({ body: generateKitCodesBody }), kitCodeManagementController.generate);
