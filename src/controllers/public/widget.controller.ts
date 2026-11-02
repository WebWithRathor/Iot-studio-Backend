import type { z } from 'zod';
import { widgetService } from '../../services/public/widget.service';
import { sendCreated, sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import type { createWidgetBody, updateWidgetBody, widgetParams } from '../../validations/public/widget.validation';

export const widgetController = {
  add: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof createWidgetBody>;
    sendCreated(req, res, await widgetService.add(req.user!.id, (req.validated.params as { id: string }).id, body));
  }),

  update: asyncHandler(async (req, res) => {
    const p = req.validated.params as z.infer<typeof widgetParams>;
    const body = req.validated.body as z.infer<typeof updateWidgetBody>;
    sendSuccess(req, res, await widgetService.update(req.user!.id, p.id, p.widgetId, body));
  }),

  remove: asyncHandler(async (req, res) => {
    const p = req.validated.params as z.infer<typeof widgetParams>;
    sendSuccess(req, res, await widgetService.remove(req.user!.id, p.id, p.widgetId));
  }),
};
