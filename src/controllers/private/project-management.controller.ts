import type { z } from 'zod';
import { projectManagementService } from '../../services/private/project-management.service';
import { sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import type { adminDeleteProjectBody, adminListProjectsQuery } from '../../validations/private/project-management.validation';

export const projectManagementController = {
  list: asyncHandler(async (req, res) => {
    const q = req.validated.query as z.infer<typeof adminListProjectsQuery>;
    sendSuccess(req, res, await projectManagementService.list(q));
  }),

  get: asyncHandler(async (req, res) => sendSuccess(req, res, await projectManagementService.get((req.validated.params as { id: string }).id))),

  remove: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof adminDeleteProjectBody>;
    sendSuccess(req, res, await projectManagementService.remove(req.user!, (req.validated.params as { id: string }).id, body.reason), { message: 'Project deleted' });
  }),
};
