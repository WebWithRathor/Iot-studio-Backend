import type { z } from 'zod';
import { auditLogService } from '../../services/private/audit-log.service';
import { sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import type { listAuditLogsQuery } from '../../validations/private/audit-log.validation';

export const auditLogController = {
  list: asyncHandler(async (req, res) => {
    const { page, pageSize, ...filter } = req.validated.query as z.infer<typeof listAuditLogsQuery>;
    sendSuccess(req, res, await auditLogService.list(filter, page, pageSize));
  }),
};
