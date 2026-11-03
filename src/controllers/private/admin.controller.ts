import type { z } from 'zod';
import { adminService } from '../../services/private/admin.service';
import { sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import { appSettings } from '../../services/shared/app-settings.service';
import type { appSettingsBody, overviewQuery } from '../../validations/private/admin.validation';

export const adminController = {
  overview: asyncHandler(async (req, res) => {
    const q = req.validated.query as z.infer<typeof overviewQuery>;
    sendSuccess(req, res, await adminService.overview(q.hours));
  }),

  dbMetrics: asyncHandler(async (req, res) => sendSuccess(req, res, adminService.dbMetrics())),

  resetDbMetrics: asyncHandler(async (req, res) => sendSuccess(req, res, adminService.resetDbMetrics())),

  settings: asyncHandler(async (req, res) => sendSuccess(req, res, appSettings.get())),

  updateSettings: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof appSettingsBody>;
    sendSuccess(req, res, await appSettings.update(req.user!, body));
  }),
};
