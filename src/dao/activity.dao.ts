import type { ClientSession, FilterQuery } from 'mongoose';
import { ActivityModel, type ActivityDoc } from '../models/activity.model';
import { dbOp } from '../utils/logger.util';
import { oid } from '../utils/id.util';

const E = 'Activity';

export const activityDao = {
  create: (data: Omit<ActivityDoc, '_id'>) => dbOp(E, 'create', async () => (await ActivityModel.create(data)).toObject() as ActivityDoc, { quiet: true }),

  createMany: (docs: Array<Omit<ActivityDoc, '_id'>>, session?: ClientSession) =>
    dbOp(E, 'createMany', async () => (docs.length ? (await ActivityModel.insertMany(docs, { session })).map((d) => d.toObject() as ActivityDoc) : [])),

  listForOwner: (ownerId: string, limit: number, before?: number) =>
    dbOp(E, 'listForOwner', () => {
      const q: FilterQuery<ActivityDoc> = { ownerId: oid(ownerId) };
      if (before) q.at = { $lt: new Date(before) };
      return ActivityModel.find(q).sort({ at: -1, _id: -1 }).limit(limit).lean<ActivityDoc[]>().exec();
    }),

  /** Project events plus device events for the project's devices (like the frontend feed). */
  listForProject: (ownerId: string, projectId: string, deviceIds: string[], limit: number, before?: number) =>
    dbOp(E, 'listForProject', () => {
      const q: FilterQuery<ActivityDoc> = {
        ownerId: oid(ownerId),
        $or: [{ projectId: oid(projectId) }, { projectId: null, deviceId: { $in: deviceIds.map(oid) } }],
      };
      if (before) q.at = { $lt: new Date(before) };
      return ActivityModel.find(q).sort({ at: -1, _id: -1 }).limit(limit).lean<ActivityDoc[]>().exec();
    }, { id: projectId }),

  deleteByProject: (projectId: string, session?: ClientSession) =>
    dbOp(E, 'deleteByProject', () => ActivityModel.deleteMany({ projectId: oid(projectId) }, { session }).exec(), { id: projectId }),

  deleteAllOwned: (ownerId: string, session?: ClientSession) => dbOp(E, 'deleteAllOwned', () => ActivityModel.deleteMany({ ownerId: oid(ownerId) }, { session }).exec()),
};
