import { Types } from 'mongoose';
import { LIMITS } from '../../constants/app.constants';
import { ERROR_CODES } from '../../constants/error-codes.constants';
import { dashboardDao } from '../../dao/dashboard.dao';
import { projectDao } from '../../dao/project.dao';
import { variableDao } from '../../dao/variable.dao';
import { withTransaction } from '../../database/mongo.transactions';
import type { DashboardDTO, ProjectDTO } from '../../types/project.types';
import { conflict, limitReached, notFound, unsupported } from '../../utils/error.util';
import { traced } from '../../utils/logger.util';
import type { WidgetInput } from '../../validations/public/widget.validation';
import { TOKEN_COSTS } from '../../constants/plans.constants';
import { activityService } from '../shared/activity.service';
import { toDashboardDTO, toProjectDTO } from '../shared/mappers';
import { chargedWidgets, tokenWallet } from '../shared/token-wallet.service';
import { validateWidgets } from './widget.service';
import { diffWidgets } from '../../utils/widget-compat.util';

const WIDGET_NAMES: Record<string, string> = {
  button: 'Button', toggle: 'Toggle switch', slider: 'Slider', arc_slider: 'Arc slider', color_wheel: 'Color wheel', rotary: 'Rotary knob', stepper: 'Stepper',
  mode_selector: 'Mode selector', momentary: 'Hold button', level_bar: 'Level bar',
  numeric: 'Numeric value', text: 'Text display', gauge: 'Gauge', progress: 'Circular progress', status: 'Status indicator', value_card: 'Sensor card',
  line_chart: 'Line chart', area_chart: 'Area chart', bar_chart: 'Bar chart', table: 'Data table', label: 'Label', divider: 'Divider', device_status: 'Device status', event_log: 'Event log',
};

const lastUpdateLog = new Map<string, number>();

export const dashboardService = {
  listForProject: (userId: string, projectId: string) =>
    traced('DashboardService.listForProject', async (): Promise<DashboardDTO[]> => {
      if (!(await projectDao.findOwned(projectId, userId))) throw notFound('Project');
      return (await dashboardDao.listByProject(projectId, userId)).map(toDashboardDTO);
    }),

  get: (userId: string, id: string) =>
    traced('DashboardService.get', async (): Promise<DashboardDTO> => {
      const d = await dashboardDao.findOwned(id, userId);
      if (!d) throw notFound('Dashboard');
      return toDashboardDTO(d);
    }),

  create: (userId: string, projectId: string, name: string) =>
    traced('DashboardService.create', (): Promise<{ dashboard: DashboardDTO; project: ProjectDTO }> => tokenWallet.withWallet(userId, async () => {
      const project = await projectDao.findOwned(projectId, userId);
      if (!project) throw notFound('Project');
      if (project.dashboardIds.length >= LIMITS.MAX_DASHBOARDS_PER_PROJECT) throw limitReached(`A project can have at most ${LIMITS.MAX_DASHBOARDS_PER_PROJECT} dashboards.`);
      if (project.dashboardIds.length > 0) await tokenWallet.assertCanAfford(userId, TOKEN_COSTS.dashboard, 'add a dashboard');
      const result = await withTransaction('dashboard.create', async (session) => {
        const d = await dashboardDao.create({ projectId: project._id, ownerId: project.ownerId, name }, session);
        const p = await projectDao.addDashboard(projectId, userId, d._id, session);
        return { d, p };
      });
      await activityService.record({ ownerId: userId, projectId, type: 'dashboard.created', message: `Dashboard “${name}” created` });
      return { dashboard: toDashboardDTO(result.d), project: toProjectDTO(result.p!) };
    })),

  rename: (userId: string, id: string, name: string) =>
    traced('DashboardService.rename', async (): Promise<DashboardDTO> => {
      const d = await dashboardDao.rename(id, userId, name);
      if (!d) throw notFound('Dashboard');
      await projectDao.touchUpdated(String(d.projectId));
      return toDashboardDTO(d);
    }),

  /** A project keeps at least one dashboard; deleting the default promotes the next one. */
  remove: (userId: string, id: string) =>
    traced('DashboardService.remove', async (): Promise<ProjectDTO> => {
      const d = await dashboardDao.findOwned(id, userId);
      if (!d) throw notFound('Dashboard');
      const project = await projectDao.findOwned(String(d.projectId), userId);
      if (!project) throw notFound('Project');
      const remaining = project.dashboardIds.filter((x) => String(x) !== id);
      if (!remaining.length) throw unsupported('A project needs at least one dashboard.');
      const updated = await withTransaction('dashboard.delete', async (session) => {
        await dashboardDao.deleteOwned(id, userId, session);
        return projectDao.updateOwned(String(project._id), userId, {
          dashboardIds: remaining,
          defaultDashboardId: String(project.defaultDashboardId) === id ? (remaining[0] as Types.ObjectId) : project.defaultDashboardId,
        }, session);
      });
      await activityService.record({ ownerId: userId, projectId: String(project._id), type: 'dashboard.deleted', message: `Dashboard “${d.name}” deleted` });
      return toProjectDTO(updated!);
    }),

  /**
   * Save the editor's widget list (moves, resizes, config, bindings, undo/redo).
   * Optimistic concurrency: a stale `revision` → 409 REVISION_CONFLICT.
   */
  replaceWidgets: (userId: string, id: string, widgets: WidgetInput[], revision?: number) =>
    traced('DashboardService.replaceWidgets', (): Promise<DashboardDTO> => tokenWallet.withWallet(userId, async () => {
      const before = await dashboardDao.findOwned(id, userId);
      if (!before) throw notFound('Dashboard');
      const projectId = String(before.projectId);
      const docs = await validateWidgets(userId, projectId, widgets);
      // Only growth is charged: moving, editing or removing widgets always saves.
      const n = Math.max(0, chargedWidgets(docs.length, before.freeWidgets) - chargedWidgets(before.widgets.length, before.freeWidgets));
      await tokenWallet.assertCanAfford(userId, n * TOKEN_COSTS.widget, n === 1 ? 'add this widget' : `add ${n} widgets`);
      const saved = await dashboardDao.replaceWidgets(id, userId, docs, revision);
      if (!saved) {
        const now = await dashboardDao.findOwned(id, userId);
        if (!now) throw notFound('Dashboard');
        throw conflict('This dashboard was changed in another tab or device. Reload to get the latest version.', ERROR_CODES.REVISION_CONFLICT, { currentRevision: now.revision });
      }
      await projectDao.touchUpdated(projectId);
      // Meaningful activity only.
      const { added, removed, rebound } = diffWidgets(before.widgets, saved.widgets);
      const vars = rebound.length ? new Map((await variableDao.listByProject(projectId, userId)).map((v) => [String(v._id), v.key])) : new Map<string, string>();
      for (const w of added) await activityService.record({ ownerId: userId, projectId, type: 'widget.added', message: `${WIDGET_NAMES[w.type] ?? w.type} “${w.config.title}” added to ${saved.name}` });
      for (const w of removed) await activityService.record({ ownerId: userId, projectId, type: 'widget.removed', message: `“${w.config.title}” removed from ${saved.name}` });
      for (const w of rebound) {
        const key = w.binding ? vars.get(String(w.binding.variableId)) : null;
        await activityService.record({ ownerId: userId, projectId, type: 'binding.changed', message: key ? `“${w.config.title}” bound to ${key}` : `“${w.config.title}” unbound` });
      }
      if (!added.length && !removed.length && !rebound.length && Date.now() - (lastUpdateLog.get(id) ?? 0) > 120_000) {
        lastUpdateLog.set(id, Date.now());
        await activityService.record({ ownerId: userId, projectId, type: 'dashboard.updated', message: `“${saved.name}” layout edited` });
      }
      return toDashboardDTO(saved);
    })),
};
