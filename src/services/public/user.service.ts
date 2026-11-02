import * as argon2 from 'argon2';
import { loadEnv } from '../../config/env.config';
import { ERROR_CODES } from '../../constants/error-codes.constants';
import { activityDao } from '../../dao/activity.dao';
import { dashboardDao } from '../../dao/dashboard.dao';
import { deviceDao } from '../../dao/device.dao';
import { projectDao } from '../../dao/project.dao';
import { userDao } from '../../dao/user.dao';
import { variableDao } from '../../dao/variable.dao';
import { withTransaction } from '../../database/mongo.transactions';
import type { ActivityEventDTO, WorkspaceDTO } from '../../types/project.types';
import type { ClientInfo } from '../../types/auth.types';
import type { UserDTO } from '../../types/user.types';
import { AppError, notFound, unauthenticated, unsupported } from '../../utils/error.util';
import { traced } from '../../utils/logger.util';
import { auditLogService } from '../private/audit-log.service';
import { toActivityDTO } from '../shared/activity.service';
import { demoWorkspaceService } from '../shared/demo-workspace.service';
import { deviceRegistry } from '../shared/device-registry.service';
import { deviceSimulator } from '../shared/device-simulator.service';
import { kitCodeService } from '../shared/kit-code.service';
import { tokenWallet } from '../shared/token-wallet.service';
import type { TokenStateDTO } from '../../types/token.types';
import { toDashboardDTO, toDeviceDTO, toProjectDTO, toUserDTO, toVariableDTO } from '../shared/mappers';
import { redisService } from '../shared/redis.service';
import { hashPassword, revokeAllSessions } from './auth.service';
import { refreshUserStreams } from './device.service';

export const userService = {
  profile: (userId: string) =>
    traced('UserService.profile', async (): Promise<UserDTO> => {
      const u = await userDao.findById(userId);
      if (!u) throw notFound('User');
      return toUserDTO(u);
    }),

  updateProfile: (userId: string, input: { name: string }) =>
    traced('UserService.updateProfile', async (): Promise<UserDTO> => {
      const u = await userDao.updateProfile(userId, { name: input.name });
      if (!u) throw notFound('User');
      await redisService.dropUserAuth(userId);
      return toUserDTO(u);
    }),

  updatePreferences: (userId: string, prefs: { onboardingDismissed?: boolean }) =>
    traced('UserService.updatePreferences', async (): Promise<UserDTO> => {
      const u = await userDao.updatePreferences(userId, prefs);
      if (!u) throw notFound('User');
      return toUserDTO(u);
    }),

  /** Verifies the current password, rotates the hash, signs out every OTHER session. */
  changePassword: (userId: string, sessionId: string, input: { currentPassword: string; newPassword: string }, client: ClientInfo) =>
    traced('UserService.changePassword', async (): Promise<void> => {
      const u = await userDao.findByIdWithSecrets(userId);
      if (!u) throw notFound('User');
      // An LMS-created account has no password yet: its first password needs no "current password".
      let ok = u.passwordSet === false;
      if (!ok) {
        try {
          ok = await argon2.verify(u.passwordHash, input.currentPassword);
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        await auditLogService.record({ action: 'auth.password.change', outcome: 'failure', actor: { id: userId, role: u.role }, ip: client.ip });
        throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, 'Your current password is incorrect.', { fieldErrors: { currentPassword: 'Incorrect password.' } });
      }
      await userDao.setPasswordHash(userId, await hashPassword(input.newPassword));
      await revokeAllSessions(userId, 'password_change', sessionId);
      await redisService.dropUserAuth(userId);
      await auditLogService.record({ action: 'auth.password.change', outcome: 'success', actor: { id: userId, role: u.role }, ip: client.ip });
      // tokenVersion changed: the caller re-authenticates (controller clears cookies → login screen).
    }),

  /** Everything the frontend's studio store needs, in one call (replaces its former localStorage load). */
  workspace: (userId: string) =>
    traced('UserService.workspace', async (): Promise<WorkspaceDTO> => {
      const [user, projects, dashboards, variables, devices, activity] = await Promise.all([
        userDao.findById(userId),
        projectDao.listAllOwned(userId),
        dashboardDao.listByOwner(userId),
        variableDao.listByOwner(userId),
        deviceDao.listOwned(userId),
        activityDao.listForOwner(userId, 200),
      ]);
      if (!user) throw unauthenticated();
      const tokens = await tokenWallet.state(userId);
      return {
        schemaVersion: 1,
        tokens,
        projects: projects.map(toProjectDTO),
        dashboards: dashboards.map(toDashboardDTO),
        variables: variables.map(toVariableDTO),
        devices: devices.map(toDeviceDTO),
        activity: activity.map(toActivityDTO),
        preferences: { simIntervalMs: deviceSimulator.status().intervalMs, onboardingDismissed: Boolean(user.preferences?.onboardingDismissed) },
      };
    }),

  tokens: (userId: string) => traced('UserService.tokens', (): Promise<TokenStateDTO> => tokenWallet.state(userId)),

  /** Redeem the activation code from a kit box: upgrades the plan (or adds a second allowance). */
  redeemKit: (userId: string, role: string, code: string, client: ClientInfo) =>
    traced('UserService.redeemKit', async (): Promise<{ tokens: TokenStateDTO; upgraded: boolean }> => {
      try {
        const r = await kitCodeService.redeem(userId, code);
        await auditLogService.record({ action: 'plan.kit.redeem', outcome: 'success', actor: { id: userId, role }, target: { type: 'kit_code', id: r.codeId }, ip: client.ip, metadata: { from: r.from, to: r.to, last4: r.last4 } });
        return { tokens: await tokenWallet.state(userId), upgraded: r.upgraded };
      } catch (err) {
        if (err instanceof AppError && err.code === ERROR_CODES.INVALID_KIT_CODE) {
          await auditLogService.record({ action: 'plan.kit.redeem', outcome: 'failure', actor: { id: userId, role }, ip: client.ip });
        }
        throw err;
      }
    }),

  activity: (userId: string, limit: number, before?: number) =>
    traced('UserService.activity', async (): Promise<ActivityEventDTO[]> => (await activityDao.listForOwner(userId, limit, before)).map(toActivityDTO)),

  /**
   * "Reset demo data": delete the caller's projects, dashboards, variables,
   * activity and DEMO devices, then rebuild the sample workspace.
   * Devices registered by an administrator are kept. Disabled in production.
   */
  resetDemoWorkspace: (userId: string, role: string) =>
    traced('UserService.resetDemoWorkspace', async (): Promise<WorkspaceDTO> => {
      const e = loadEnv();
      if (e.NODE_ENV === 'production' || !e.DEMO_WORKSPACE_ON_SIGNUP) throw unsupported('Demo data reset is not available on this server.');
      const devices = await deviceDao.listOwned(userId);
      const demoDevices = devices.filter((d) => d.simulated || !d.registeredBy);
      await withTransaction('workspace.reset', async (session) => {
        await dashboardDao.deleteAllOwned(userId, session);
        await variableDao.deleteAllOwned(userId, session);
        await activityDao.deleteAllOwned(userId, session);
        await projectDao.deleteAllOwned(userId, session);
      });
      for (const d of demoDevices) {
        await deviceDao.deleteById(String(d._id));
        deviceSimulator.forget(String(d._id));
      }
      await redisService.dropLatest(demoDevices.map((d) => String(d._id))).catch(() => undefined);
      await demoWorkspaceService.createFor(userId);
      await deviceRegistry.refresh();
      await refreshUserStreams(userId);
      await auditLogService.record({ action: 'workspace.demo.reset', outcome: 'success', actor: { id: userId, role } });
      return userService.workspace(userId);
    }),
};
