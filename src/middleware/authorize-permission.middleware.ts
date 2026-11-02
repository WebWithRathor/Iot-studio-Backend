import type { NextFunction, Request, Response } from 'express';
import type { Permission } from '../constants/permissions.constants';
import { auditLogService } from '../services/private/audit-log.service';
import { authorizationService } from '../services/shared/authorization.service';
import { forbidden, unauthenticated } from '../utils/error.util';

/**
 * Require ALL listed permissions. Every protected route declares one, so
 * permission checks never depend on what the UI chooses to show.
 * Denials are audited.
 */
export const authorizePermission =
  (...permissions: Permission[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(unauthenticated());
    if (authorizationService.hasAllPermissions(req.user.role, permissions)) return next();
    void auditLogService.record({ action: 'authz.denied', outcome: 'denied', actor: { id: req.user.id, role: req.user.role }, metadata: { required: permissions, method: req.method, path: req.baseUrl + req.path } });
    next(forbidden());
  };
