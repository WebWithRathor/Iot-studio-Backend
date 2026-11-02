import type { z } from 'zod';
import { deviceManagementService } from '../../services/private/device-management.service';
import { sendCreated, sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import type { adminListDevicesQuery, adminUpdateDeviceBody, registerDeviceBody } from '../../validations/private/device-management.validation';

export const deviceManagementController = {
  list: asyncHandler(async (req, res) => {
    const q = req.validated.query as z.infer<typeof adminListDevicesQuery>;
    sendSuccess(req, res, await deviceManagementService.list(q));
  }),

  register: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof registerDeviceBody>;
    sendCreated(req, res, await deviceManagementService.register(req.user!, body), 'Device registered');
  }),

  update: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof adminUpdateDeviceBody>;
    sendSuccess(req, res, await deviceManagementService.update(req.user!, (req.validated.params as { id: string }).id, body));
  }),

  remove: asyncHandler(async (req, res) => sendSuccess(req, res, await deviceManagementService.remove(req.user!, (req.validated.params as { id: string }).id), { message: 'Device deleted' })),
};
