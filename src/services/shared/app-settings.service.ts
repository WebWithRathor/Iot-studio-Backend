import { redisKeys } from '../../config/redis.config';
import { loadEnv } from '../../config/env.config';
import type { AuthUser } from '../../types/auth.types';
import { channel } from '../../utils/logger.util';
import { auditLogService } from '../private/audit-log.service';
import { redisService } from './redis.service';

/**
 * Switches an administrator flips from the admin panel. Kept in Redis so every
 * backend process agrees, with the env value as the starting point.
 *
 *   tokensEnabled  — the build budget (plans, kit codes, token costs). Off:
 *                    nothing is charged and the UI hides every token element.
 */
export interface AppSettings {
  tokensEnabled: boolean;
}

let current: AppSettings | null = null;

const defaults = (): AppSettings => ({ tokensEnabled: loadEnv().TOKENS_ENABLED });

export const appSettings = {
  /** Read the stored settings once at startup (falls back to the env defaults). */
  async load(): Promise<AppSettings> {
    current = defaults();
    try {
      const raw = await redisService.getRaw(redisKeys.appSettings());
      if (raw) current = { ...current, ...(JSON.parse(raw) as Partial<AppSettings>) };
    } catch (err) {
      channel('app').warn('app.settings.load.failed', { errorName: (err as Error).name });
    }
    return current;
  },

  get: (): AppSettings => current ?? defaults(),

  tokensEnabled: (): boolean => (current ?? defaults()).tokensEnabled,

  async update(actor: AuthUser, patch: Partial<AppSettings>): Promise<AppSettings> {
    const before = appSettings.get();
    const next = { ...before, ...patch };
    await redisService.setRaw(redisKeys.appSettings(), JSON.stringify(next));
    current = next;
    await auditLogService.record({ action: 'app.settings.change', outcome: 'success', actor: { id: actor.id, role: actor.role }, metadata: { before, after: next } });
    return next;
  },
};
