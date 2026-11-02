import { dashboardDao } from '../../dao/dashboard.dao';
import { notFound } from '../../utils/error.util';
import { traced } from '../../utils/logger.util';
import { toDashboardDTO } from '../shared/mappers';

/** Read-only cross-tenant dashboard inspection for support. */
export const dashboardManagementService = {
  list: (q: { projectId?: string; ownerId?: string; page: number; pageSize: number; sort: { field: string; direction: 1 | -1 } }) =>
    traced('DashboardManagementService.list', async () => {
      const r = await dashboardDao.paginateAll({ projectId: q.projectId, ownerId: q.ownerId }, q.page, q.pageSize, q.sort);
      return {
        ...r,
        items: r.items.map((d) => ({ id: String(d._id), projectId: String(d.projectId), ownerId: String(d.ownerId), name: d.name, widgetCount: d.widgets?.length ?? 0, revision: d.revision, updatedAt: d.updatedAt.getTime() })),
      };
    }),

  get: (id: string) =>
    traced('DashboardManagementService.get', async () => {
      const d = await dashboardDao.findAny(id);
      if (!d) throw notFound('Dashboard');
      return { ...toDashboardDTO(d), ownerId: String(d.ownerId) };
    }),
};
