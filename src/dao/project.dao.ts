import type { ClientSession, FilterQuery, SortOrder, Types } from 'mongoose';
import { ProjectModel, type ProjectDoc } from '../models/project.model';
import type { Page } from '../types/common.types';
import { dbOp } from '../utils/logger.util';
import { oid } from '../utils/id.util';

const E = 'Project';

export interface ProjectListOptions {
  q?: string; // regex-escaped by the service
  category?: string;
  sort: { field: 'updatedAt' | 'createdAt' | 'lastActivityAt' | 'name'; direction: 1 | -1 };
  page: number;
  pageSize: number;
}

type NewProject = Omit<ProjectDoc, '_id' | 'createdAt' | 'updatedAt'> & { _id?: Types.ObjectId };
type ProjectPatch = Partial<Pick<ProjectDoc, 'name' | 'description' | 'category' | 'icon' | 'accent' | 'settings' | 'defaultDashboardId' | 'lmsProgram' | 'dashboardIds'>>;

/** Every public query is scoped by ownerId. Admin (unscoped) methods are named *Any / paginateAll. */
export const projectDao = {
  create: (data: NewProject, session?: ClientSession) =>
    dbOp(E, 'create', async () => {
      const [doc] = await ProjectModel.create([data], { session });
      return doc.toObject() as ProjectDoc;
    }),

  findOwned: (id: string, ownerId: string, session?: ClientSession) =>
    dbOp(E, 'findOwned', () => ProjectModel.findOne({ _id: oid(id), ownerId: oid(ownerId) }).session(session ?? null).lean<ProjectDoc>().exec(), { id }),

  listOwned: (ownerId: string, o: ProjectListOptions): Promise<Page<ProjectDoc>> =>
    dbOp(E, 'listOwned', async () => {
      const filter: FilterQuery<ProjectDoc> = { ownerId: oid(ownerId) };
      if (o.category) filter.category = o.category;
      if (o.q) filter.$or = [{ name: { $regex: o.q, $options: 'i' } }, { description: { $regex: o.q, $options: 'i' } }];
      const [items, total] = await Promise.all([
        ProjectModel.find(filter).sort({ [o.sort.field]: o.sort.direction as SortOrder, _id: 1 }).skip((o.page - 1) * o.pageSize).limit(o.pageSize).lean<ProjectDoc[]>().exec(),
        ProjectModel.countDocuments(filter).exec(),
      ]);
      return { items, page: o.page, pageSize: o.pageSize, total, totalPages: Math.max(1, Math.ceil(total / o.pageSize)) };
    }),

  listAllOwned: (ownerId: string) =>
    dbOp(E, 'listAllOwned', () => ProjectModel.find({ ownerId: oid(ownerId) }).sort({ updatedAt: -1 }).limit(500).lean<ProjectDoc[]>().exec()),

  /** The user's project created from an LMS program (most recently updated wins). */
  findOwnedByLmsProgram: (ownerId: string, programId: string) =>
    dbOp(E, 'findOwnedByLmsProgram', () =>
      ProjectModel.findOne({ ownerId: oid(ownerId), 'lmsProgram.programId': programId, 'lmsProgram.source': 'lms' }).sort({ updatedAt: -1 }).lean<ProjectDoc>().exec()),

  /** Ids of the owner's projects that include a device. */
  listIdsWithDevice: (ownerId: string, deviceId: string) =>
    dbOp(E, 'listIdsWithDevice', async () => (await ProjectModel.find({ ownerId: oid(ownerId), deviceIds: oid(deviceId) }).select('_id').lean<Array<{ _id: Types.ObjectId }>>().exec()).map((p) => String(p._id))),

  countOwned: (ownerId: string) => dbOp(E, 'countOwned', () => ProjectModel.countDocuments({ ownerId: oid(ownerId) }).exec()),

  /** The few fields the token budget needs. */
  listTokenFacts: (ownerId: string) =>
    dbOp(E, 'listTokenFacts', () => ProjectModel.find({ ownerId: oid(ownerId) }).select('_id sample').lean<Array<Pick<ProjectDoc, '_id' | 'sample'>>>().exec(), { quiet: true }),

  updateOwned: (id: string, ownerId: string, set: ProjectPatch, session?: ClientSession) =>
    dbOp(E, 'updateOwned', () =>
      ProjectModel.findOneAndUpdate({ _id: oid(id), ownerId: oid(ownerId) }, { $set: set }, { new: true, runValidators: true, session }).lean<ProjectDoc>().exec(), { id }),

  addDashboard: (id: string, ownerId: string, dashboardId: Types.ObjectId, session?: ClientSession) =>
    dbOp(E, 'addDashboard', () =>
      ProjectModel.findOneAndUpdate({ _id: oid(id), ownerId: oid(ownerId) }, { $addToSet: { dashboardIds: dashboardId } }, { new: true, session }).lean<ProjectDoc>().exec(), { id }),

  addDevice: (id: string, ownerId: string, deviceId: string) =>
    dbOp(E, 'addDevice', () =>
      ProjectModel.findOneAndUpdate({ _id: oid(id), ownerId: oid(ownerId) }, { $addToSet: { deviceIds: oid(deviceId) } }, { new: true }).lean<ProjectDoc>().exec(), { id }),

  removeDevice: (id: string, ownerId: string, deviceId: string) =>
    dbOp(E, 'removeDevice', () =>
      ProjectModel.findOneAndUpdate({ _id: oid(id), ownerId: oid(ownerId) }, { $pull: { deviceIds: oid(deviceId) } }, { new: true }).lean<ProjectDoc>().exec(), { id }),

  /** Remove a device from every project of an owner (device deleted or reassigned). */
  pullDeviceForOwner: (ownerId: string, deviceId: string) =>
    dbOp(E, 'pullDeviceForOwner', () => ProjectModel.updateMany({ ownerId: oid(ownerId) }, { $pull: { deviceIds: oid(deviceId) } }).exec()),

  touchActivity: (id: string, at: Date) =>
    dbOp(E, 'touchActivity', () => ProjectModel.updateOne({ _id: oid(id) }, { $max: { lastActivityAt: at } }, { timestamps: false }).exec(), { id, quiet: true }),

  touchUpdated: (id: string, session?: ClientSession) =>
    dbOp(E, 'touchUpdated', () => ProjectModel.updateOne({ _id: oid(id) }, { $set: { updatedAt: new Date(), lastActivityAt: new Date() } }, { timestamps: false, session }).exec(), { id, quiet: true }),

  deleteOwned: (id: string, ownerId: string, session?: ClientSession) =>
    dbOp(E, 'deleteOwned', () => ProjectModel.deleteOne({ _id: oid(id), ownerId: oid(ownerId) }, { session }).exec(), { id }),

  deleteAllOwned: (ownerId: string, session?: ClientSession) =>
    dbOp(E, 'deleteAllOwned', () => ProjectModel.deleteMany({ ownerId: oid(ownerId) }, { session }).exec()),

  /* ------------------------------------------------ admin (unscoped) */

  findAny: (id: string) => dbOp(E, 'findAny', () => ProjectModel.findById(oid(id)).lean<ProjectDoc>().exec(), { id }),

  paginateAll: (f: { q?: string; ownerId?: string }, page: number, pageSize: number, sort: { field: string; direction: 1 | -1 }): Promise<Page<ProjectDoc>> =>
    dbOp(E, 'paginateAll', async () => {
      const filter: FilterQuery<ProjectDoc> = {};
      if (f.ownerId) filter.ownerId = oid(f.ownerId);
      if (f.q) filter.name = { $regex: f.q, $options: 'i' };
      const [items, total] = await Promise.all([
        ProjectModel.find(filter).sort({ [sort.field]: sort.direction as SortOrder, _id: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean<ProjectDoc[]>().exec(),
        ProjectModel.countDocuments(filter).exec(),
      ]);
      return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
    }),

  countAll: () => dbOp(E, 'countAll', () => ProjectModel.estimatedDocumentCount().exec()),
  countByOwners: (ownerIds: string[]) =>
    dbOp(E, 'countByOwners', async () => {
      const rows = await ProjectModel.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { ownerId: { $in: ownerIds.map(oid) } } }, { $group: { _id: '$ownerId', n: { $sum: 1 } } }]).exec();
      return new Map(rows.map((r) => [String(r._id), r.n]));
    }),
};
