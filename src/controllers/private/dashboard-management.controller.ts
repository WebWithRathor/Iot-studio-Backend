import type { z } from 'zod';
import { dashboardManagementService } from '../../services/private/dashboard-management.service';
import { sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import type { adminListDashboardsQuery } from '../../validations/private/dashboard-management.validation';

export const dashboardManagementController = {
  list: asyncHandler(async (req, res) => {
    const q = req.validated.query as z.infer<typeof adminListDashboardsQuery>;
    sendSuccess(req, res, await dashboardManagementService.list(q));
  }),

  get: asyncHandler(async (req, res) => sendSuccess(req, res, await dashboardManagementService.get((req.validated.params as { id: string }).id))),
};
