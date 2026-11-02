import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.constants';
import { dashboardController } from '../../controllers/public/dashboard.controller';
import { authenticate } from '../../middleware/authenticate.middleware';
import { authorizePermission } from '../../middleware/authorize-permission.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { createDashboardBody, renameDashboardBody, replaceWidgetsBody } from '../../validations/public/dashboard.validation';
import { idParams, projectIdParams } from '../../validations/shared/common.validation';

/** Mounted twice: /projects/:projectId/dashboards (collection) and /dashboards (items). */
export const projectDashboardRoutes = Router({ mergeParams: true });
projectDashboardRoutes.use(authenticate);
projectDashboardRoutes.get('/', authorizePermission(P.PROJECT_READ), validateRequest({ params: projectIdParams }), dashboardController.listForProject);
projectDashboardRoutes.post('/', authorizePermission(P.DASHBOARD_WRITE), validateRequest({ params: projectIdParams, body: createDashboardBody }), dashboardController.create);

export const dashboardRoutes = Router();
dashboardRoutes.use(authenticate);
dashboardRoutes.get('/:id', authorizePermission(P.PROJECT_READ), validateRequest({ params: idParams }), dashboardController.get);
dashboardRoutes.patch('/:id', authorizePermission(P.DASHBOARD_WRITE), validateRequest({ params: idParams, body: renameDashboardBody }), dashboardController.rename);
dashboardRoutes.delete('/:id', authorizePermission(P.DASHBOARD_WRITE), validateRequest({ params: idParams }), dashboardController.remove);
dashboardRoutes.put('/:id/widgets', authorizePermission(P.DASHBOARD_WRITE), validateRequest({ params: idParams, body: replaceWidgetsBody }), dashboardController.replaceWidgets);
