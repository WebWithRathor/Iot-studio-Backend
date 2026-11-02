import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.constants';
import { projectController } from '../../controllers/public/project.controller';
import { authenticate } from '../../middleware/authenticate.middleware';
import { authorizePermission } from '../../middleware/authorize-permission.middleware';
import { heavyLimiter } from '../../middleware/rate-limit.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { emptyBody } from '../../validations/public/auth.validation';
import { createProjectBody, importProjectBody, listProjectsQuery, projectActivityQuery, projectDeviceParams, updateProjectBody } from '../../validations/public/project.validation';
import { idParams } from '../../validations/shared/common.validation';

export const projectRoutes = Router();
projectRoutes.use(authenticate);

projectRoutes.get('/', authorizePermission(P.PROJECT_READ), validateRequest({ query: listProjectsQuery }), projectController.list);
projectRoutes.post('/', authorizePermission(P.PROJECT_WRITE), validateRequest({ body: createProjectBody }), projectController.create);
projectRoutes.post('/import', authorizePermission(P.PROJECT_WRITE), heavyLimiter(), validateRequest({ body: importProjectBody }), projectController.importBundle);
projectRoutes.get('/:id', authorizePermission(P.PROJECT_READ), validateRequest({ params: idParams }), projectController.get);
projectRoutes.patch('/:id', authorizePermission(P.PROJECT_WRITE), validateRequest({ params: idParams, body: updateProjectBody }), projectController.update);
projectRoutes.delete('/:id', authorizePermission(P.PROJECT_WRITE), validateRequest({ params: idParams }), projectController.remove);
projectRoutes.post('/:id/duplicate', authorizePermission(P.PROJECT_WRITE), validateRequest({ params: idParams, body: emptyBody }), projectController.duplicate);
projectRoutes.get('/:id/export', authorizePermission(P.PROJECT_READ), heavyLimiter(), validateRequest({ params: idParams }), projectController.exportBundle);
projectRoutes.get('/:id/activity', authorizePermission(P.ACTIVITY_READ), validateRequest({ params: idParams, query: projectActivityQuery }), projectController.activity);
projectRoutes.put('/:id/devices/:deviceId', authorizePermission(P.PROJECT_WRITE, P.DEVICE_READ), validateRequest({ params: projectDeviceParams }), projectController.associateDevice);
projectRoutes.delete('/:id/devices/:deviceId', authorizePermission(P.PROJECT_WRITE), validateRequest({ params: projectDeviceParams }), projectController.dissociateDevice);
