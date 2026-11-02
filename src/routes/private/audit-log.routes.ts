import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.constants';
import { auditLogController } from '../../controllers/private/audit-log.controller';
import { authorizePermission } from '../../middleware/authorize-permission.middleware';
import { heavyLimiter } from '../../middleware/rate-limit.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { listAuditLogsQuery } from '../../validations/private/audit-log.validation';

export const auditLogRoutes = Router();
auditLogRoutes.get('/', authorizePermission(P.AUDIT_READ), heavyLimiter(), validateRequest({ query: listAuditLogsQuery }), auditLogController.list);
