import { auditLogDao } from '../../dao/audit-log.dao';
import { dashboardDao } from '../../dao/dashboard.dao';
import { deviceDao } from '../../dao/device.dao';
import { mqttMessageDao } from '../../dao/mqtt-message.dao';
import { projectDao } from '../../dao/project.dao';
import { refreshSessionDao } from '../../dao/refresh-session.dao';
import { userDao } from '../../dao/user.dao';
import { dbMetrics } from '../../utils/db-metrics.util';
import { traced } from '../../utils/logger.util';
import { mqttStatus } from '../public/mqtt.service';
import { realtimeService } from '../shared/realtime.service';

/** Admin dashboard counters. */
export const adminService = {
  overview: (hours: number) =>
    traced('AdminService.overview', async () => {
      const since = new Date(Date.now() - hours * 3_600_000);
      const [usersByRole, newUsers, projects, dashboards, devices, messages, activeSessions, failures, denials] = await Promise.all([
        userDao.countByRole(),
        userDao.countSince(since),
        projectDao.countAll(),
        dashboardDao.countAll(),
        deviceDao.countByState(),
        mqttMessageDao.countSince(since),
        refreshSessionDao.countActive(),
        auditLogDao.countSince(since, 'failure'),
        auditLogDao.countSince(since, 'denied'),
      ]);
      return {
        windowHours: hours,
        users: { byRole: usersByRole, newInWindow: newUsers },
        projects,
        dashboards,
        devices,
        mqtt: { ...mqttStatus(), messagesInWindow: messages, sseConnections: realtimeService.count() },
        security: { activeSessions, authFailuresInWindow: failures, deniedInWindow: denials },
      };
    }),

  /** Database read/write counters since start or last reset (this API process). */
  dbMetrics: () => dbMetrics.snapshot(),

  resetDbMetrics: () => {
    dbMetrics.reset();
    return dbMetrics.snapshot();
  },
};
