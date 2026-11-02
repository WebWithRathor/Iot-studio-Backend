import { healthService } from '../../services/public/health.service';
import { buildFailure, sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import { ERROR_CODES } from '../../constants/error-codes.constants';

export const healthController = {
  live: asyncHandler(async (req, res) => sendSuccess(req, res, healthService.live())),

  ready: asyncHandler(async (req, res) => {
    const r = await healthService.ready();
    if (r.ready) return sendSuccess(req, res, r);
    res.status(503).json(buildFailure(req.requestId, ERROR_CODES.DATABASE_UNAVAILABLE, 'Not ready: a required dependency is unavailable.', r.checks));
  }),
};
