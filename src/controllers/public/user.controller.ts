import type { z } from 'zod';
import { userService } from '../../services/public/user.service';
import { cookieService } from '../../services/shared/cookie.service';
import { sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import type { activityQuery, changePasswordBody, redeemKitBody, updatePreferencesBody, updateProfileBody } from '../../validations/public/user.validation';
import { clientInfo } from './auth.controller';

export const userController = {
  me: asyncHandler(async (req, res) => sendSuccess(req, res, await userService.profile(req.user!.id))),

  updateProfile: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof updateProfileBody>;
    sendSuccess(req, res, await userService.updateProfile(req.user!.id, body), { message: 'Profile updated' });
  }),

  updatePreferences: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof updatePreferencesBody>;
    sendSuccess(req, res, await userService.updatePreferences(req.user!.id, body));
  }),

  /** Changing the password ends every session including this one: the user signs in again with the new password. */
  changePassword: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof changePasswordBody>;
    await userService.changePassword(req.user!.id, req.user!.sessionId, body, clientInfo(req));
    cookieService.clearAuthCookies(res);
    sendSuccess(req, res, { changed: true, reauthenticate: true }, { message: 'Password changed. Sign in with your new password.' });
  }),

  workspace: asyncHandler(async (req, res) => sendSuccess(req, res, await userService.workspace(req.user!.id))),

  tokens: asyncHandler(async (req, res) => sendSuccess(req, res, await userService.tokens(req.user!.id))),

  redeemKit: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof redeemKitBody>;
    const r = await userService.redeemKit(req.user!.id, req.user!.role, body.code, clientInfo(req));
    sendSuccess(req, res, r, { message: r.upgraded ? 'Kit activated — your account is now Premium' : 'Kit activated — tokens added' });
  }),

  activity: asyncHandler(async (req, res) => {
    const q = req.validated.query as z.infer<typeof activityQuery>;
    sendSuccess(req, res, await userService.activity(req.user!.id, q.limit, q.before));
  }),

  resetDemo: asyncHandler(async (req, res) => sendSuccess(req, res, await userService.resetDemoWorkspace(req.user!.id, req.user!.role), { message: 'Demo workspace restored' })),
};
