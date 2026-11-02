import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.constants';
import { deviceController } from '../../controllers/public/device.controller';
import { authenticate } from '../../middleware/authenticate.middleware';
import { authorizePermission } from '../../middleware/authorize-permission.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { createSimulatedDeviceBody, renameDeviceBody, simulationModeBody } from '../../validations/public/device.validation';
import { idParams } from '../../validations/shared/common.validation';

export const deviceRoutes = Router();
deviceRoutes.use(authenticate);

deviceRoutes.get('/', authorizePermission(P.DEVICE_READ), deviceController.list);
deviceRoutes.post('/', authorizePermission(P.DEVICE_SIMULATED_CREATE), validateRequest({ body: createSimulatedDeviceBody }), deviceController.createSimulated);
deviceRoutes.get('/:id', authorizePermission(P.DEVICE_READ), validateRequest({ params: idParams }), deviceController.get);
deviceRoutes.patch('/:id', authorizePermission(P.DEVICE_WRITE), validateRequest({ params: idParams, body: renameDeviceBody }), deviceController.rename);
deviceRoutes.post('/:id/simulation', authorizePermission(P.DEVICE_WRITE), validateRequest({ params: idParams, body: simulationModeBody }), deviceController.setSimulationMode);
