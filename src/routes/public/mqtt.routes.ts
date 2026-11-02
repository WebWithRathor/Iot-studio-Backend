import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.constants';
import { mqttController } from '../../controllers/public/mqtt.controller';
import { authenticate } from '../../middleware/authenticate.middleware';
import { authorizePermission } from '../../middleware/authorize-permission.middleware';
import { commandLimiter, heavyLimiter } from '../../middleware/rate-limit.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { commandBody, messagesQuery, rawPublishBody, snapshotQuery, telemetryQuery } from '../../validations/public/mqtt.validation';

export const mqttRoutes = Router();
mqttRoutes.use(authenticate);

mqttRoutes.get('/status', authorizePermission(P.TELEMETRY_READ), mqttController.status);
mqttRoutes.get('/snapshot', authorizePermission(P.TELEMETRY_READ), validateRequest({ query: snapshotQuery }), mqttController.snapshot);
mqttRoutes.get('/messages', authorizePermission(P.TELEMETRY_READ), validateRequest({ query: messagesQuery }), mqttController.messages);
mqttRoutes.get('/telemetry', authorizePermission(P.TELEMETRY_READ), heavyLimiter(), validateRequest({ query: telemetryQuery }), mqttController.telemetry);
mqttRoutes.post('/commands', authorizePermission(P.COMMAND_PUBLISH), commandLimiter(), validateRequest({ body: commandBody }), mqttController.command);
mqttRoutes.post('/publish', authorizePermission(P.COMMAND_PUBLISH), commandLimiter(), validateRequest({ body: rawPublishBody }), mqttController.publish);
/** Server-Sent Events: device events for the caller's devices only. */
mqttRoutes.get('/stream', authorizePermission(P.TELEMETRY_READ), mqttController.stream);
