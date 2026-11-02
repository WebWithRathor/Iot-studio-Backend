import type { NextFunction, Request, Response } from 'express';
import type { Role } from '../constants/roles.constants';
import { auditLogService } from '../services/private/audit-log.service';
import { authorizationService } from '../services/shared/authorization.service';
import { forbidden, unauthenticated } from '../utils/error.util';

/** Require at least `min` in the role hierarchy. Used to fence the whole /admin area. */
export const authorizeRole =
  (min: Role) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(unauthenticated());
    if (authorizationService.hasRoleAtLeast(req.user.role, min)) return next();
    void auditLogService.record({ action: 'authz.denied', outcome: 'denied', actor: { id: req.user.id, role: req.user.role }, metadata: { requiredRole: min, method: req.method, path: req.baseUrl + req.path } });
    next(forbidden());
  };
