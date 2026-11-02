import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.constants';
import { dashboardManagementController } from '../../controllers/private/dashboard-management.controller';
import { authorizePermission } from '../../middleware/authorize-permission.middleware';
import { heavyLimiter } from '../../middleware/rate-limit.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { adminDashboardParams, adminListDashboardsQuery } from '../../validations/private/dashboard-management.validation';

export const dashboardManagementRoutes = Router();
dashboardManagementRoutes.get('/', authorizePermission(P.DASHBOARDS_MANAGE), heavyLimiter(), validateRequest({ query: adminListDashboardsQuery }), dashboardManagementController.list);
dashboardManagementRoutes.get('/:id', authorizePermission(P.DASHBOARDS_MANAGE), validateRequest({ params: adminDashboardParams }), dashboardManagementController.get);
