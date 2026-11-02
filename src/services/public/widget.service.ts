import { LIMITS } from '../../constants/app.constants';
import { ERROR_CODES } from '../../constants/error-codes.constants';
import { dashboardDao } from '../../dao/dashboard.dao';
import { deviceDao } from '../../dao/device.dao';
import { variableDao } from '../../dao/variable.dao';
import { widgetDao } from '../../dao/widget.dao';
import type { WidgetDoc } from '../../models/widget.model';
import type { DashboardDTO } from '../../types/project.types';
import { AppError, conflict, notFound } from '../../utils/error.util';
import { oid } from '../../utils/id.util';
import { traced } from '../../utils/logger.util';
import { bindingProblem } from '../../utils/widget-compat.util';
import type { WidgetInput } from '../../validations/public/widget.validation';
import { TOKEN_COSTS } from '../../constants/plans.constants';
import { toDashboardDTO } from '../shared/mappers';
import { chargedWidgets, tokenWallet } from '../shared/token-wallet.service';

/**
 * Validate widgets against the database: every bound variable must exist in
 * the SAME project (owned by the caller) and be compatible with the widget
 * type; device_status widgets may only reference the caller's devices.
 * Returns the widgets converted to their persisted form.
 */
export async function validateWidgets(userId: string, projectId: string, widgets: WidgetInput[]): Promise<WidgetDoc[]> {
  const varIds = Array.from(new Set(widgets.map((w) => w.binding?.variableId).filter((v): v is string => Boolean(v))));
  const deviceIds = Array.from(new Set(widgets.map((w) => w.config.deviceId).filter((v): v is string => Boolean(v))));
  const [vars, devices] = await Promise.all([
    varIds.length ? variableDao.listOwnedByIds(varIds, userId) : Promise.resolve([]),
    deviceIds.length ? deviceDao.findOwnedByIds(deviceIds, userId) : Promise.resolve([]),
  ]);
  const varMap = new Map(vars.map((v) => [String(v._id), v]));
  const deviceSet = new Set(devices.map((d) => String(d._id)));
  const problems: Record<string, string> = {};
  for (const w of widgets) {
    if (w.binding) {
      const v = varMap.get(w.binding.variableId);
      if (!v || String(v.projectId) !== projectId) problems[w.id] = 'Bound variable does not exist in this project.';
      else {
        const p = bindingProblem(w.type, { dataType: v.dataType, direction: v.direction, commandTopic: v.commandTopic });
        if (p) problems[w.id] = p;
      }
    }
    if (w.config.deviceId && !deviceSet.has(w.config.deviceId)) problems[w.id] = 'Device not found.';
  }
  if (Object.keys(problems).length) throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, 'Some widgets have invalid bindings.', { widgets: problems });
  return widgets.map((w) => ({
    id: w.id,
    type: w.type,
    layout: w.layout,
    config: { ...w.config, deviceId: w.config.deviceId ? oid(w.config.deviceId) : undefined },
    binding: w.binding ? { variableId: oid(w.binding.variableId), scale: w.binding.scale, offset: w.binding.offset } : null,
  }));
}

/** Single-widget endpoints (the editor uses the batch PUT; these serve API clients and scripts). */
export const widgetService = {
  add: (userId: string, dashboardId: string, widget: WidgetInput) =>
    traced('WidgetService.add', (): Promise<DashboardDTO> => tokenWallet.withWallet(userId, async () => {
      const dash = await dashboardDao.findOwned(dashboardId, userId);
      if (!dash) throw notFound('Dashboard');
      if (dash.widgets.some((w) => w.id === widget.id)) throw conflict('A widget with this id already exists on the dashboard.', ERROR_CODES.DUPLICATE);
      const [doc] = await validateWidgets(userId, String(dash.projectId), [widget]);
      const extra = chargedWidgets(dash.widgets.length + 1, dash.freeWidgets) - chargedWidgets(dash.widgets.length, dash.freeWidgets);
      await tokenWallet.assertCanAfford(userId, extra * TOKEN_COSTS.widget, 'add this widget');
      const updated = await widgetDao.add(dashboardId, userId, doc, LIMITS.MAX_WIDGETS_PER_DASHBOARD);
      if (!updated) throw conflict(`A dashboard can hold at most ${LIMITS.MAX_WIDGETS_PER_DASHBOARD} widgets.`, ERROR_CODES.LIMIT_REACHED);
      return toDashboardDTO(updated);
    })),

  update: (userId: string, dashboardId: string, widgetId: string, patch: Partial<Pick<WidgetInput, 'layout' | 'config' | 'binding'>>) =>
    traced('WidgetService.update', async (): Promise<DashboardDTO> => {
      const dash = await dashboardDao.findOwned(dashboardId, userId);
      const current = dash?.widgets.find((w) => w.id === widgetId);
      if (!dash || !current) throw notFound('Widget');
      const merged: WidgetInput = {
        id: current.id,
        type: current.type,
        layout: patch.layout ?? current.layout,
        config: (patch.config ?? { ...current.config, deviceId: current.config.deviceId ? String(current.config.deviceId) : undefined }) as WidgetInput['config'],
        binding: patch.binding !== undefined ? patch.binding : current.binding ? { variableId: String(current.binding.variableId), scale: current.binding.scale, offset: current.binding.offset } : null,
      };
      const [doc] = await validateWidgets(userId, String(dash.projectId), [merged]);
      const updated = await widgetDao.update(dashboardId, userId, widgetId, { layout: doc.layout, config: doc.config, binding: doc.binding });
      if (!updated) throw notFound('Widget');
      return toDashboardDTO(updated);
    }),

  remove: (userId: string, dashboardId: string, widgetId: string) =>
    traced('WidgetService.remove', async (): Promise<DashboardDTO> => {
      const updated = await widgetDao.remove(dashboardId, userId, widgetId);
      if (!updated) throw notFound('Widget');
      return toDashboardDTO(updated);
    }),
};
