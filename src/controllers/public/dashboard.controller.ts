import type { z } from 'zod';
import { dashboardService } from '../../services/public/dashboard.service';
import { sendCreated, sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import type { createDashboardBody, renameDashboardBody, replaceWidgetsBody } from '../../validations/public/dashboard.validation';

export const dashboardController = {
  listForProject: asyncHandler(async (req, res) => sendSuccess(req, res, await dashboardService.listForProject(req.user!.id, (req.validated.params as { projectId: string }).projectId))),

  create: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof createDashboardBody>;
    sendCreated(req, res, await dashboardService.create(req.user!.id, (req.validated.params as { projectId: string }).projectId, body.name));
  }),

  get: asyncHandler(async (req, res) => sendSuccess(req, res, await dashboardService.get(req.user!.id, (req.validated.params as { id: string }).id))),

  rename: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof renameDashboardBody>;
    sendSuccess(req, res, await dashboardService.rename(req.user!.id, (req.validated.params as { id: string }).id, body.name));
  }),

  remove: asyncHandler(async (req, res) => sendSuccess(req, res, await dashboardService.remove(req.user!.id, (req.validated.params as { id: string }).id), { message: 'Dashboard deleted' })),

  replaceWidgets: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof replaceWidgetsBody>;
    sendSuccess(req, res, await dashboardService.replaceWidgets(req.user!.id, (req.validated.params as { id: string }).id, body.widgets, body.revision));
  }),
};
