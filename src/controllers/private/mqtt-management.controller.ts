import type { z } from 'zod';
import { mqttManagementService } from '../../services/private/mqtt-management.service';
import { sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import type { adminMessagesQuery, simulationSettingsBody } from '../../validations/private/mqtt-management.validation';

export const mqttManagementController = {
  status: asyncHandler(async (req, res) => sendSuccess(req, res, mqttManagementService.status())),

  setSimulation: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof simulationSettingsBody>;
    sendSuccess(req, res, await mqttManagementService.setSimulation(req.user!, body));
  }),

  messages: asyncHandler(async (req, res) => {
    const q = req.validated.query as z.infer<typeof adminMessagesQuery>;
    sendSuccess(req, res, await mqttManagementService.messages(q));
  }),
};
