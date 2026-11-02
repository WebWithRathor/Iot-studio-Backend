import type { z } from 'zod';
import { variableService } from '../../services/public/variable.service';
import { sendCreated, sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import type { createVariableBody, importVariableBody, updateVariableBody } from '../../validations/public/variable.validation';

type ProjectParams = { projectId: string };

export const variableController = {
  list: asyncHandler(async (req, res) => sendSuccess(req, res, await variableService.list(req.user!.id, (req.validated.params as ProjectParams).projectId))),

  create: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof createVariableBody>;
    sendCreated(req, res, await variableService.create(req.user!.id, (req.validated.params as ProjectParams).projectId, body));
  }),

  importFromDevice: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof importVariableBody>;
    sendCreated(req, res, await variableService.importFromDevice(req.user!.id, (req.validated.params as ProjectParams).projectId, body.deviceId, body.key));
  }),

  update: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof updateVariableBody>;
    sendSuccess(req, res, await variableService.update(req.user!.id, (req.validated.params as { id: string }).id, body));
  }),

  remove: asyncHandler(async (req, res) => sendSuccess(req, res, await variableService.remove(req.user!.id, (req.validated.params as { id: string }).id), { message: 'Variable deleted' })),
};
