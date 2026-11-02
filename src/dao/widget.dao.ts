import { DashboardModel, type DashboardDoc } from '../models/dashboard.model';
import type { WidgetDoc } from '../models/widget.model';
import { dbOp } from '../utils/logger.util';
import { oid } from '../utils/id.util';

const E = 'Widget';

/**
 * Single-widget operations on the embedded `dashboards.widgets` array.
 * Each one is a single atomic update that also bumps the dashboard revision,
 * so it plays well with the editor's whole-layout saves.
 */
export const widgetDao = {
  /** Adds the widget unless the id already exists or the dashboard is full. Returns null otherwise. */
  add: (dashboardId: string, ownerId: string, widget: WidgetDoc, maxWidgets: number) =>
    dbOp(E, 'add', () =>
      DashboardModel.findOneAndUpdate(
        { _id: oid(dashboardId), ownerId: oid(ownerId), 'widgets.id': { $ne: widget.id }, [`widgets.${maxWidgets - 1}`]: { $exists: false } },
        { $push: { widgets: widget }, $inc: { revision: 1 } },
        { new: true, runValidators: true },
      ).lean<DashboardDoc>().exec(), { id: widget.id }),

  update: (dashboardId: string, ownerId: string, widgetId: string, set: Partial<Pick<WidgetDoc, 'layout' | 'config' | 'binding'>>) => {
    const $set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(set)) if (v !== undefined) $set[`widgets.$.${k}`] = v;
    return dbOp(E, 'update', () =>
      DashboardModel.findOneAndUpdate({ _id: oid(dashboardId), ownerId: oid(ownerId), 'widgets.id': widgetId }, { $set, $inc: { revision: 1 } }, { new: true, runValidators: true })
        .lean<DashboardDoc>()
        .exec(), { id: widgetId });
  },

  remove: (dashboardId: string, ownerId: string, widgetId: string) =>
    dbOp(E, 'remove', () =>
      DashboardModel.findOneAndUpdate({ _id: oid(dashboardId), ownerId: oid(ownerId), 'widgets.id': widgetId }, { $pull: { widgets: { id: widgetId } }, $inc: { revision: 1 } }, { new: true })
        .lean<DashboardDoc>()
        .exec(), { id: widgetId }),
};
