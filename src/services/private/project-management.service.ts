import { activityDao } from '../../dao/activity.dao';
import { dashboardDao } from '../../dao/dashboard.dao';
import { projectDao } from '../../dao/project.dao';
import { variableDao } from '../../dao/variable.dao';
import { withTransaction } from '../../database/mongo.transactions';
import type { AuthUser } from '../../types/auth.types';
import { notFound } from '../../utils/error.util';
import { traced } from '../../utils/logger.util';
import { escapeRegex } from '../../validations/shared/common.validation';
import { deviceRegistry } from '../shared/device-registry.service';
import { toProjectDTO } from '../shared/mappers';
import { realtimeService } from '../shared/realtime.service';
import { auditLogService } from './audit-log.service';

/** Cross-tenant project administration (moderation, support). Every destructive action is audited. */
export const projectManagementService = {
  list: (q: { q?: string; ownerId?: string; page: number; pageSize: number; sort: { field: string; direction: 1 | -1 } }) =>
    traced('ProjectManagementService.list', async () => {
      const r = await projectDao.paginateAll({ q: q.q ? escapeRegex(q.q) : undefined, ownerId: q.ownerId }, q.page, q.pageSize, q.sort);
      return { ...r, items: r.items.map((p) => ({ ...toProjectDTO(p), ownerId: String(p.ownerId) })) };
    }),

  get: (id: string) =>
    traced('ProjectManagementService.get', async () => {
      const p = await projectDao.findAny(id);
      if (!p) throw notFound('Project');
      return { ...toProjectDTO(p), ownerId: String(p.ownerId) };
    }),

  remove: (actor: AuthUser, id: string, reason: string) =>
    traced('ProjectManagementService.remove', async () => {
      const p = await projectDao.findAny(id);
      if (!p) throw notFound('Project');
      await withTransaction('admin.project.delete', async (session) => {
        await dashboardDao.deleteByProject(id, session);
        await variableDao.deleteByProject(id, session);
        await activityDao.deleteByProject(id, session);
        await projectDao.deleteOwned(id, String(p.ownerId), session);
      });
      deviceRegistry.invalidate();
      realtimeService.toUser(String(p.ownerId), { type: 'workspace', data: { reason: 'project_removed_by_admin' } });
      await auditLogService.record({ action: 'project.admin.delete', outcome: 'success', actor: { id: actor.id, role: actor.role }, target: { type: 'project', id }, metadata: { ownerId: String(p.ownerId), name: p.name, reason } });
      return { id };
    }),
};
