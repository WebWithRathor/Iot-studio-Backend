import type { ActivityType } from '../../constants/app.constants';
import { activityDao } from '../../dao/activity.dao';
import { projectDao } from '../../dao/project.dao';
import type { ActivityDoc } from '../../models/activity.model';
import type { ActivityEventDTO } from '../../types/project.types';
import { oid } from '../../utils/id.util';
import { channel } from '../../utils/logger.util';
import { realtimeService } from './realtime.service';

export const toActivityDTO = (a: ActivityDoc): ActivityEventDTO => ({
  id: String(a._id),
  type: a.type,
  message: a.message,
  at: a.at.getTime(),
  projectId: a.projectId ? String(a.projectId) : null,
  deviceId: a.deviceId ? String(a.deviceId) : null,
});

/**
 * Records user-facing activity (the project feed). Shared because many
 * services emit events. Recording never fails the request that triggered it:
 * the primary change has already been saved, so errors are logged instead.
 */
export const activityService = {
  async record(e: { ownerId: string; type: ActivityType; message: string; projectId?: string | null; deviceId?: string | null; at?: Date }): Promise<void> {
    try {
      const at = e.at ?? new Date();
      const doc = await activityDao.create({
        ownerId: oid(e.ownerId),
        projectId: e.projectId ? oid(e.projectId) : null,
        deviceId: e.deviceId ? oid(e.deviceId) : null,
        type: e.type,
        message: e.message.slice(0, 300),
        at,
      });
      if (e.projectId) await projectDao.touchActivity(e.projectId, at);
      realtimeService.toUser(e.ownerId, { type: 'activity', data: toActivityDTO(doc) });
    } catch (err) {
      channel('app').warn('activity.record.failed', { type: e.type, errorName: (err as Error).name });
    }
  },
};
