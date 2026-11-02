import type { z } from 'zod';
import { deviceService } from '../../services/public/device.service';
import { sendCreated, sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import type { createSimulatedDeviceBody, renameDeviceBody, simulationModeBody } from '../../validations/public/device.validation';

type IdParams = { id: string };

export const deviceController = {
  list: asyncHandler(async (req, res) => sendSuccess(req, res, await deviceService.list(req.user!.id))),

  get: asyncHandler(async (req, res) => sendSuccess(req, res, await deviceService.get(req.user!.id, (req.validated.params as IdParams).id))),

  createSimulated: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof createSimulatedDeviceBody>;
    sendCreated(req, res, await deviceService.createSimulated(req.user!.id, body), 'Simulated device added');
  }),

  rename: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof renameDeviceBody>;
    sendSuccess(req, res, await deviceService.rename(req.user!.id, (req.validated.params as IdParams).id, body.name));
  }),

  setSimulationMode: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof simulationModeBody>;
    sendSuccess(req, res, await deviceService.setSimulationMode(req.user!.id, (req.validated.params as IdParams).id, body.mode));
  }),
};
