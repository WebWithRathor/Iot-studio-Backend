import type { z } from 'zod';
import { userManagementService } from '../../services/private/user-management.service';
import { sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import type { changePlanBody, changeRoleBody, changeStatusBody, listUsersQuery } from '../../validations/private/user-management.validation';

type IdParams = { id: string };

export const userManagementController = {
  list: asyncHandler(async (req, res) => {
    const q = req.validated.query as z.infer<typeof listUsersQuery>;
    sendSuccess(req, res, await userManagementService.list(q));
  }),

  get: asyncHandler(async (req, res) => sendSuccess(req, res, await userManagementService.get((req.validated.params as IdParams).id))),

  changeRole: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof changeRoleBody>;
    sendSuccess(req, res, await userManagementService.changeRole(req.user!, (req.validated.params as IdParams).id, body.role, body.reason), { message: 'Role changed; the user was signed out everywhere' });
  }),

  changePlan: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof changePlanBody>;
    sendSuccess(req, res, await userManagementService.changePlan(req.user!, (req.validated.params as IdParams).id, body), { message: 'Plan updated' });
  }),

  changeStatus: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof changeStatusBody>;
    sendSuccess(req, res, await userManagementService.changeStatus(req.user!, (req.validated.params as IdParams).id, body.status, body.reason));
  }),

  revokeSessions: asyncHandler(async (req, res) => sendSuccess(req, res, await userManagementService.revokeSessions(req.user!, (req.validated.params as IdParams).id))),

  sessions: asyncHandler(async (req, res) => sendSuccess(req, res, await userManagementService.sessions(req.user!, (req.validated.params as IdParams).id))),
};
