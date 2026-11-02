import { refreshSessionDao } from '../dao/refresh-session.dao';
import { channel, traced } from '../utils/logger.util';

/**
 * Housekeeping. Expired sessions disappear via the TTL index; revoked ones
 * are kept 7 days for review and then removed here. Redis session keys
 * expire on their own (TTL = refresh lifetime).
 */
const EVERY_MS = 60 * 60_000;
const KEEP_REVOKED_DAYS = 7;
let timer: NodeJS.Timeout | null = null;

export async function runCleanupOnce(): Promise<number> {
  return traced('CleanupExpiredSessionsJob', async () => {
    const r = await refreshSessionDao.deleteRevokedBefore(new Date(Date.now() - KEEP_REVOKED_DAYS * 86_400_000));
    const n = r.deletedCount ?? 0;
    channel('app').info('job.cleanup-sessions', { deleted: n });
    return n;
  });
}

export function startCleanupJob(): void {
  if (timer) return;
  timer = setInterval(() => void runCleanupOnce().catch((err) => channel('app').error('job.cleanup-sessions.failed', { errorName: (err as Error).name })), EVERY_MS);
  timer.unref();
  setTimeout(() => void runCleanupOnce().catch(() => undefined), 30_000).unref();
}

export function stopCleanupJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
