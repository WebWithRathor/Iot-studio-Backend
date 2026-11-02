import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.constants';
import { deviceManagementController } from '../../controllers/private/device-management.controller';
import { authorizePermission } from '../../middleware/authorize-permission.middleware';
import { heavyLimiter } from '../../middleware/rate-limit.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { adminListDevicesQuery, adminUpdateDeviceBody, registerDeviceBody } from '../../validations/private/device-management.validation';
import { idParams } from '../../validations/shared/common.validation';

export const deviceManagementRoutes = Router();
deviceManagementRoutes.get('/', authorizePermission(P.DEVICES_MANAGE), heavyLimiter(), validateRequest({ query: adminListDevicesQuery }), deviceManagementController.list);
deviceManagementRoutes.post('/', authorizePermission(P.DEVICES_MANAGE), validateRequest({ body: registerDeviceBody }), deviceManagementController.register);
deviceManagementRoutes.patch('/:id', authorizePermission(P.DEVICES_MANAGE), validateRequest({ params: idParams, body: adminUpdateDeviceBody }), deviceManagementController.update);
deviceManagementRoutes.delete('/:id', authorizePermission(P.DEVICES_MANAGE), validateRequest({ params: idParams }), deviceManagementController.remove);
