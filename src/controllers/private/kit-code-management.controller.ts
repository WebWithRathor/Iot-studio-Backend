import type { z } from 'zod';
import { kitCodeManagementService } from '../../services/private/kit-code-management.service';
import { sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import type { generateKitCodesBody, listKitCodesQuery } from '../../validations/private/kit-code.validation';

export const kitCodeManagementController = {
  list: asyncHandler(async (req, res) => sendSuccess(req, res, await kitCodeManagementService.list(req.validated.query as z.infer<typeof listKitCodesQuery>))),

  generate: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof generateKitCodesBody>;
    const r = await kitCodeManagementService.generate(req.user!, body);
    sendSuccess(req, res, r, { message: `${r.codes.length} kit code${r.codes.length === 1 ? '' : 's'} generated — copy them now, they are not shown again`, status: 201 });
  }),
};
