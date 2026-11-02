import type { ClientSession, Types } from 'mongoose';
import { VariableModel, type VariableDoc } from '../models/variable.model';
import { dbOp } from '../utils/logger.util';
import { oid } from '../utils/id.util';

const E = 'Variable';
type NewVariable = Omit<VariableDoc, '_id' | 'createdAt' | 'updatedAt'> & { _id?: Types.ObjectId };
type VariablePatch = Partial<Omit<VariableDoc, '_id' | 'projectId' | 'ownerId' | 'createdAt' | 'updatedAt' | 'firmwareRef'>>;

export const variableDao = {
  create: (data: NewVariable, session?: ClientSession) =>
    dbOp(E, 'create', async () => {
      const [doc] = await VariableModel.create([data], { session });
      return doc.toObject() as VariableDoc;
    }),

  createMany: (docs: NewVariable[], session?: ClientSession) =>
    dbOp(E, 'createMany', async () => {
      if (!docs.length) return [] as VariableDoc[];
      const created = await VariableModel.insertMany(docs, { session });
      return created.map((c) => c.toObject() as VariableDoc);
    }),

  findOwned: (id: string, ownerId: string) =>
    dbOp(E, 'findOwned', () => VariableModel.findOne({ _id: oid(id), ownerId: oid(ownerId) }).lean<VariableDoc>().exec(), { id }),

  listByProject: (projectId: string, ownerId: string) =>
    dbOp(E, 'listByProject', () => VariableModel.find({ projectId: oid(projectId), ownerId: oid(ownerId) }).sort({ createdAt: 1 }).lean<VariableDoc[]>().exec(), { id: projectId }),

  listByOwner: (ownerId: string) => dbOp(E, 'listByOwner', () => VariableModel.find({ ownerId: oid(ownerId) }).sort({ createdAt: 1 }).limit(5000).lean<VariableDoc[]>().exec()),

  listOwnedByIds: (ids: string[], ownerId: string) =>
    dbOp(E, 'listOwnedByIds', () => VariableModel.find({ _id: { $in: ids.map(oid) }, ownerId: oid(ownerId) }).lean<VariableDoc[]>().exec()),

  /** Variables (any owner) whose topics fall in the given set — used by the MQTT router. */
  listByDevices: (deviceIds: string[]) =>
    dbOp(E, 'listByDevices', () => VariableModel.find({ deviceId: { $in: deviceIds.map(oid) } }).lean<VariableDoc[]>().exec(), { quiet: true }),

  findOwnedByCommandTopic: (topic: string, ownerId: string) =>
    dbOp(E, 'findOwnedByCommandTopic', () => VariableModel.findOne({ commandTopic: topic, ownerId: oid(ownerId) }).lean<VariableDoc>().exec()),

  countByProject: (projectId: string) => dbOp(E, 'countByProject', () => VariableModel.countDocuments({ projectId: oid(projectId) }).exec(), { id: projectId }),

  keyExists: (projectId: string, key: string, excludeId?: string) =>
    dbOp(E, 'keyExists', async () => Boolean(await VariableModel.exists({ projectId: oid(projectId), key, ...(excludeId ? { _id: { $ne: oid(excludeId) } } : {}) }).exec())),

  update: (id: string, ownerId: string, set: VariablePatch) => {
    const $unset: Record<string, 1> = {};
    const $set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(set)) {
      if (v === undefined) $unset[k] = 1;
      else $set[k] = v;
    }
    return dbOp(E, 'update', () =>
      VariableModel.findOneAndUpdate({ _id: oid(id), ownerId: oid(ownerId) }, { $set, ...(Object.keys($unset).length ? { $unset } : {}) }, { new: true, runValidators: true })
        .lean<VariableDoc>()
        .exec(), { id });
  },

  /** LMS sync: overwrite a variable from the firmware declaration, including its firmwareRef. */
  updateFromFirmware: (id: string, ownerId: string, set: Partial<Omit<VariableDoc, '_id' | 'projectId' | 'ownerId' | 'createdAt' | 'updatedAt'>>) => {
    const $unset: Record<string, 1> = {};
    const $set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(set)) {
      if (v === undefined) $unset[k] = 1;
      else $set[k] = v;
    }
    return dbOp(E, 'updateFromFirmware', () =>
      VariableModel.findOneAndUpdate({ _id: oid(id), ownerId: oid(ownerId) }, { $set, ...(Object.keys($unset).length ? { $unset } : {}) }, { new: true, runValidators: true })
        .lean<VariableDoc>()
        .exec(), { id });
  },

  /** LMS sync: flag this device's firmware variables in a project that the latest program no longer declares. */
  markUndeclared: (projectId: string, deviceId: string, declaredKeys: string[]) =>
    dbOp(E, 'markUndeclared', () =>
      VariableModel.updateMany(
        { projectId: oid(projectId), deviceId: oid(deviceId), 'firmwareRef.source': 'lms', 'firmwareRef.variableName': { $nin: declaredKeys } },
        { $set: { 'firmwareRef.declared': false } },
      ).exec(), { id: projectId }),

  /** Detach a device from variables when it leaves a project owner's hands. */
  clearDevice: (deviceId: string) => dbOp(E, 'clearDevice', () => VariableModel.updateMany({ deviceId: oid(deviceId) }, { $set: { deviceId: null } }).exec(), { id: deviceId }),

  deleteOwned: (id: string, ownerId: string, session?: ClientSession) =>
    dbOp(E, 'deleteOwned', () => VariableModel.deleteOne({ _id: oid(id), ownerId: oid(ownerId) }, { session }).exec(), { id }),

  deleteByProject: (projectId: string, session?: ClientSession) =>
    dbOp(E, 'deleteByProject', () => VariableModel.deleteMany({ projectId: oid(projectId) }, { session }).exec(), { id: projectId }),

  deleteAllOwned: (ownerId: string, session?: ClientSession) => dbOp(E, 'deleteAllOwned', () => VariableModel.deleteMany({ ownerId: oid(ownerId) }, { session }).exec()),
};
