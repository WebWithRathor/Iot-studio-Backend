import { Router } from 'express';
import { PERMISSIONS as P } from '../../constants/permissions.constants';
import { variableController } from '../../controllers/public/variable.controller';
import { authenticate } from '../../middleware/authenticate.middleware';
import { authorizePermission } from '../../middleware/authorize-permission.middleware';
import { validateRequest } from '../../middleware/validate-request.middleware';
import { createVariableBody, importVariableBody, updateVariableBody } from '../../validations/public/variable.validation';
import { idParams, projectIdParams } from '../../validations/shared/common.validation';

/** /projects/:projectId/variables */
export const projectVariableRoutes = Router({ mergeParams: true });
projectVariableRoutes.use(authenticate);
projectVariableRoutes.get('/', authorizePermission(P.PROJECT_READ), validateRequest({ params: projectIdParams }), variableController.list);
projectVariableRoutes.post('/', authorizePermission(P.VARIABLE_WRITE), validateRequest({ params: projectIdParams, body: createVariableBody }), variableController.create);
projectVariableRoutes.post('/import', authorizePermission(P.VARIABLE_WRITE), validateRequest({ params: projectIdParams, body: importVariableBody }), variableController.importFromDevice);

/** /variables/:id */
export const variableRoutes = Router();
variableRoutes.use(authenticate);
variableRoutes.put('/:id', authorizePermission(P.VARIABLE_WRITE), validateRequest({ params: idParams, body: updateVariableBody }), variableController.update);
variableRoutes.delete('/:id', authorizePermission(P.VARIABLE_WRITE), validateRequest({ params: idParams }), variableController.remove);
