import type { z } from 'zod';
import { projectService } from '../../services/public/project.service';
import { sendCreated, sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import type { createProjectBody, importProjectBody, listProjectsQuery, projectActivityQuery, projectDeviceParams, updateProjectBody } from '../../validations/public/project.validation';

type IdParams = { id: string };

export const projectController = {
  list: asyncHandler(async (req, res) => {
    const q = req.validated.query as z.infer<typeof listProjectsQuery>;
    sendSuccess(req, res, await projectService.list(req.user!.id, q));
  }),

  get: asyncHandler(async (req, res) => sendSuccess(req, res, await projectService.get(req.user!.id, (req.validated.params as IdParams).id))),

  create: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof createProjectBody>;
    sendCreated(req, res, await projectService.create(req.user!.id, body), `Created “${body.name}”`);
  }),

  update: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof updateProjectBody>;
    sendSuccess(req, res, await projectService.update(req.user!.id, (req.validated.params as IdParams).id, body));
  }),

  remove: asyncHandler(async (req, res) => sendSuccess(req, res, await projectService.remove(req.user!.id, (req.validated.params as IdParams).id), { message: 'Project deleted' })),

  duplicate: asyncHandler(async (req, res) => sendCreated(req, res, await projectService.duplicate(req.user!.id, (req.validated.params as IdParams).id))),

  exportBundle: asyncHandler(async (req, res) => sendSuccess(req, res, await projectService.exportBundle(req.user!.id, (req.validated.params as IdParams).id))),

  importBundle: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof importProjectBody>;
    sendCreated(req, res, await projectService.importBundle(req.user!.id, body));
  }),

  associateDevice: asyncHandler(async (req, res) => {
    const p = req.validated.params as z.infer<typeof projectDeviceParams>;
    sendSuccess(req, res, await projectService.associateDevice(req.user!.id, p.id, p.deviceId));
  }),

  dissociateDevice: asyncHandler(async (req, res) => {
    const p = req.validated.params as z.infer<typeof projectDeviceParams>;
    sendSuccess(req, res, await projectService.dissociateDevice(req.user!.id, p.id, p.deviceId));
  }),

  activity: asyncHandler(async (req, res) => {
    const q = req.validated.query as z.infer<typeof projectActivityQuery>;
    sendSuccess(req, res, await projectService.activity(req.user!.id, (req.validated.params as IdParams).id, q.limit, q.before));
  }),
};
