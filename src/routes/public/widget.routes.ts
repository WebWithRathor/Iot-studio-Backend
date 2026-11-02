import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.constants';
import { widgetController } from '../../controllers/public/widget.controller';
import { authenticate } from '../../middleware/authenticate.middleware';
import { authorizePermission } from '../../middleware/authorize-permission.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { createWidgetBody, updateWidgetBody, widgetParams } from '../../validations/public/widget.validation';
import { idParams } from '../../validations/shared/common.validation';

/** Mounted at /dashboards — single-widget operations on a dashboard. */
export const widgetRoutes = Router();
widgetRoutes.use(authenticate);
widgetRoutes.post('/:id/widgets', authorizePermission(P.DASHBOARD_WRITE), validateRequest({ params: idParams, body: createWidgetBody }), widgetController.add);
widgetRoutes.patch('/:id/widgets/:widgetId', authorizePermission(P.DASHBOARD_WRITE), validateRequest({ params: widgetParams, body: updateWidgetBody }), widgetController.update);
widgetRoutes.delete('/:id/widgets/:widgetId', authorizePermission(P.DASHBOARD_WRITE), validateRequest({ params: widgetParams }), widgetController.remove);
