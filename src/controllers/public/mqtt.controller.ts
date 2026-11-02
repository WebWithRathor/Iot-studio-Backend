import type { z } from 'zod';
import { mqttService } from '../../services/public/mqtt.service';
import { sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import type { commandBody, messagesQuery, rawPublishBody, snapshotQuery, telemetryQuery } from '../../validations/public/mqtt.validation';

export const mqttController = {
  status: asyncHandler(async (req, res) => sendSuccess(req, res, mqttService.status())),

  snapshot: asyncHandler(async (req, res) => {
    const q = req.validated.query as z.infer<typeof snapshotQuery>;
    sendSuccess(req, res, await mqttService.snapshot(req.user!, q.historyMinutes));
  }),

  messages: asyncHandler(async (req, res) => {
    const q = req.validated.query as z.infer<typeof messagesQuery>;
    sendSuccess(req, res, await mqttService.messages(req.user!, q));
  }),

  telemetry: asyncHandler(async (req, res) => {
    const q = req.validated.query as z.infer<typeof telemetryQuery>;
    sendSuccess(req, res, await mqttService.telemetry(req.user!, q.variableIds, q.since, q.limit));
  }),

  /** 202: the command was published; confirmation arrives later as an SSE `command` event. */
  command: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof commandBody>;
    sendSuccess(req, res, await mqttService.sendCommand(req.user!, body.variableId, body.value), { status: 202, message: 'Command published — waiting for the device to acknowledge' });
  }),

  publish: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof rawPublishBody>;
    sendSuccess(req, res, await mqttService.publishRaw(req.user!, body.topic, body.payload), { status: 202 });
  }),

  stream: asyncHandler(async (req, res) => mqttService.openStream(req, res)),
};
