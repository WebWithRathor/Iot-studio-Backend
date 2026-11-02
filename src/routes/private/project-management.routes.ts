import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.constants';
import { projectManagementController } from '../../controllers/private/project-management.controller';
import { authorizePermission } from '../../middleware/authorize-permission.middleware';
import { heavyLimiter } from '../../middleware/rate-limit.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { adminDeleteProjectBody, adminListProjectsQuery } from '../../validations/private/project-management.validation';
import { idParams } from '../../validations/shared/common.validation';

export const projectManagementRoutes = Router();
projectManagementRoutes.get('/', authorizePermission(P.PROJECTS_MANAGE), heavyLimiter(), validateRequest({ query: adminListProjectsQuery }), projectManagementController.list);
projectManagementRoutes.get('/:id', authorizePermission(P.PROJECTS_MANAGE), validateRequest({ params: idParams }), projectManagementController.get);
projectManagementRoutes.delete('/:id', authorizePermission(P.PROJECTS_MANAGE), validateRequest({ params: idParams, body: adminDeleteProjectBody }), projectManagementController.remove);
