import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.constants';
import { mqttManagementController } from '../../controllers/private/mqtt-management.controller';
import { authorizePermission } from '../../middleware/authorize-permission.middleware';
import { heavyLimiter } from '../../middleware/rate-limit.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { adminMessagesQuery, simulationSettingsBody } from '../../validations/private/mqtt-management.validation';

export const mqttManagementRoutes = Router();
mqttManagementRoutes.get('/status', authorizePermission(P.MQTT_MANAGE), mqttManagementController.status);
mqttManagementRoutes.patch('/simulation', authorizePermission(P.MQTT_MANAGE), validateRequest({ body: simulationSettingsBody }), mqttManagementController.setSimulation);
mqttManagementRoutes.get('/messages', authorizePermission(P.MQTT_MANAGE), heavyLimiter(), validateRequest({ query: adminMessagesQuery }), mqttManagementController.messages);
