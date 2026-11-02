import type { z } from 'zod';
import { adminService } from '../../services/private/admin.service';
import { sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import type { overviewQuery } from '../../validations/private/admin.validation';

export const adminController = {
  overview: asyncHandler(async (req, res) => {
    const q = req.validated.query as z.infer<typeof overviewQuery>;
    sendSuccess(req, res, await adminService.overview(q.hours));
  }),

  dbMetrics: asyncHandler(async (req, res) => sendSuccess(req, res, adminService.dbMetrics())),

  resetDbMetrics: asyncHandler(async (req, res) => sendSuccess(req, res, adminService.resetDbMetrics())),
};
