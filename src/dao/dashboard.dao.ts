import type { ClientSession, FilterQuery, SortOrder, Types } from 'mongoose';
import { DashboardModel, type DashboardDoc } from '../models/dashboard.model';
import type { WidgetDoc } from '../models/widget.model';
import type { Page } from '../types/common.types';
import { dbOp } from '../utils/logger.util';
import { oid } from '../utils/id.util';

const E = 'Dashboard';

export const dashboardDao = {
  create: (data: { _id?: Types.ObjectId; projectId: Types.ObjectId; ownerId: Types.ObjectId; name: string; widgets?: WidgetDoc[]; freeWidgets?: number }, session?: ClientSession) =>
    dbOp(E, 'create', async () => {
      const [doc] = await DashboardModel.create([{ revision: 0, widgets: [], ...data }], { session });
      return doc.toObject() as DashboardDoc;
    }),

  createMany: (docs: Array<{ _id: Types.ObjectId; projectId: Types.ObjectId; ownerId: Types.ObjectId; name: string; widgets: WidgetDoc[] }>, session?: ClientSession) =>
    dbOp(E, 'createMany', async () => {
      const created = await DashboardModel.insertMany(docs.map((d) => ({ revision: 0, ...d })), { session });
      return created.map((c) => c.toObject() as DashboardDoc);
    }),

  findOwned: (id: string, ownerId: string, session?: ClientSession) =>
    dbOp(E, 'findOwned', () => DashboardModel.findOne({ _id: oid(id), ownerId: oid(ownerId) }).session(session ?? null).lean<DashboardDoc>().exec(), { id }),

  listByProject: (projectId: string, ownerId: string) =>
    dbOp(E, 'listByProject', () => DashboardModel.find({ projectId: oid(projectId), ownerId: oid(ownerId) }).sort({ createdAt: 1 }).lean<DashboardDoc[]>().exec(), { id: projectId }),

  listByOwner: (ownerId: string) =>
    dbOp(E, 'listByOwner', () => DashboardModel.find({ ownerId: oid(ownerId) }).sort({ createdAt: 1 }).limit(2000).lean<DashboardDoc[]>().exec()),

  /** Per dashboard: project, widget count and free widget slots — for the token budget. */
  listTokenFacts: (ownerId: string) =>
    dbOp(E, 'listTokenFacts', () =>
      DashboardModel.aggregate<{ projectId: Types.ObjectId; widgets: number; freeWidgets: number }>([
        { $match: { ownerId: oid(ownerId) } },
        { $project: { _id: 0, projectId: 1, widgets: { $size: { $ifNull: ['$widgets', []] } }, freeWidgets: { $ifNull: ['$freeWidgets', 0] } } },
      ]).exec(), { quiet: true }),

  countByProject: (projectId: string) => dbOp(E, 'countByProject', () => DashboardModel.countDocuments({ projectId: oid(projectId) }).exec(), { id: projectId }),

  rename: (id: string, ownerId: string, name: string) =>
    dbOp(E, 'rename', () => DashboardModel.findOneAndUpdate({ _id: oid(id), ownerId: oid(ownerId) }, { $set: { name } }, { new: true, runValidators: true }).lean<DashboardDoc>().exec(), { id }),

  /**
   * Atomic whole-layout save with optimistic concurrency. Returns null when
   * the dashboard is missing OR the revision is stale; the service tells the
   * two apart.
   */
  replaceWidgets: (id: string, ownerId: string, widgets: WidgetDoc[], expectedRevision?: number) =>
    dbOp(E, 'replaceWidgets', () => {
      const filter: FilterQuery<DashboardDoc> = { _id: oid(id), ownerId: oid(ownerId) };
      if (expectedRevision !== undefined) filter.revision = expectedRevision;
      return DashboardModel.findOneAndUpdate(filter, { $set: { widgets }, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean<DashboardDoc>().exec();
    }, { id }),

  /** Clear bindings to a deleted variable in every dashboard of the project. */
  unbindVariable: (projectId: string, variableId: string, session?: ClientSession) =>
    dbOp(E, 'unbindVariable', () =>
      DashboardModel.updateMany(
        { projectId: oid(projectId), 'widgets.binding.variableId': oid(variableId) },
        { $set: { 'widgets.$[w].binding': null }, $inc: { revision: 1 } },
        { arrayFilters: [{ 'w.binding.variableId': oid(variableId) }], session },
      ).exec(), { id: variableId }),

  deleteOwned: (id: string, ownerId: string, session?: ClientSession) =>
    dbOp(E, 'deleteOwned', () => DashboardModel.deleteOne({ _id: oid(id), ownerId: oid(ownerId) }, { session }).exec(), { id }),

  deleteByProject: (projectId: string, session?: ClientSession) =>
    dbOp(E, 'deleteByProject', () => DashboardModel.deleteMany({ projectId: oid(projectId) }, { session }).exec(), { id: projectId }),

  deleteAllOwned: (ownerId: string, session?: ClientSession) => dbOp(E, 'deleteAllOwned', () => DashboardModel.deleteMany({ ownerId: oid(ownerId) }, { session }).exec()),

  /* ------------------------------------------------ admin (unscoped) */

  findAny: (id: string) => dbOp(E, 'findAny', () => DashboardModel.findById(oid(id)).lean<DashboardDoc>().exec(), { id }),

  paginateAll: (f: { projectId?: string; ownerId?: string }, page: number, pageSize: number, sort: { field: string; direction: 1 | -1 }): Promise<Page<DashboardDoc>> =>
    dbOp(E, 'paginateAll', async () => {
      const filter: FilterQuery<DashboardDoc> = {};
      if (f.projectId) filter.projectId = oid(f.projectId);
      if (f.ownerId) filter.ownerId = oid(f.ownerId);
      const [items, total] = await Promise.all([
        DashboardModel.find(filter).select('-widgets.config').sort({ [sort.field]: sort.direction as SortOrder, _id: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean<DashboardDoc[]>().exec(),
        DashboardModel.countDocuments(filter).exec(),
      ]);
      return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
    }),

  countAll: () => dbOp(E, 'countAll', () => DashboardModel.estimatedDocumentCount().exec()),
};
