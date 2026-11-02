import type { ClientSession, FilterQuery, SortOrder, Types } from 'mongoose';
import { DeviceModel, type DeviceDoc } from '../models/device.model';
import type { ConnectionState } from '../constants/mqtt.constants';
import type { Page } from '../types/common.types';
import { dbOp } from '../utils/logger.util';
import { oid } from '../utils/id.util';

const E = 'Device';
type NewDevice = Omit<DeviceDoc, '_id' | 'createdAt' | 'updatedAt' | 'connectionState' | 'connectionSince' | 'lastSeenAt'> & { _id?: Types.ObjectId };

export const deviceDao = {
  create: (data: NewDevice, session?: ClientSession) =>
    dbOp(E, 'create', async () => {
      const [doc] = await DeviceModel.create([{ ...data, connectionState: data.simulated ? 'connecting' : 'waiting' }], { session });
      return doc.toObject() as DeviceDoc;
    }),

  findOwned: (id: string, ownerId: string) =>
    dbOp(E, 'findOwned', () => DeviceModel.findOne({ _id: oid(id), ownerId: oid(ownerId) }).lean<DeviceDoc>().exec(), { id }),

  listOwned: (ownerId: string) => dbOp(E, 'listOwned', () => DeviceModel.find({ ownerId: oid(ownerId) }).sort({ createdAt: 1 }).limit(500).lean<DeviceDoc[]>().exec()),

  /** Owned devices among the given ids (used to validate associations). */
  findOwnedByIds: (ids: string[], ownerId: string) =>
    dbOp(E, 'findOwnedByIds', () => DeviceModel.find({ _id: { $in: ids.map(oid) }, ownerId: oid(ownerId) }).lean<DeviceDoc[]>().exec()),

  countOwned: (ownerId: string) => dbOp(E, 'countOwned', () => DeviceModel.countDocuments({ ownerId: oid(ownerId) }).exec()),

  /** Devices that count toward MAX_DEVICES_PER_USER for LMS flashing (a board removed in the LMS frees its slot). */
  countActiveOwned: (ownerId: string) => dbOp(E, 'countActiveOwned', () => DeviceModel.countDocuments({ ownerId: oid(ownerId), status: 'active' }).exec()),

  /** All devices that may send or receive messages (routing table for the MQTT pipeline). */
  listActive: () => dbOp(E, 'listActive', () => DeviceModel.find({ status: 'active' }).lean<DeviceDoc[]>().exec(), { quiet: true }),

  findByHardwareId: (hardwareId: string) => dbOp(E, 'findByHardwareId', () => DeviceModel.findOne({ hardwareId }).lean<DeviceDoc>().exec()),

  /** One query for many hardware ids (LMS bulk status). */
  findByHardwareIds: (hardwareIds: string[]) =>
    dbOp(E, 'findByHardwareIds', () => DeviceModel.find({ hardwareId: { $in: hardwareIds } }).lean<DeviceDoc[]>().exec(), { quiet: true }),

  /** The other ACTIVE device bound to this chip, if any. */
  findActiveByChip: (chipId: string, excludeId?: string) =>
    dbOp(E, 'findActiveByChip', () => DeviceModel.findOne({ chipId, status: 'active', ...(excludeId ? { _id: { $ne: oid(excludeId) } } : {}) }).lean<DeviceDoc>().exec()),

  /**
   * LMS sync: refresh a device from the latest flashed program (and re-activate it).
   * `chipId` binds a chip; `credentialsOwed` marks the broker credentials as not issued yet.
   */
  lmsSync: (
    id: string,
    set: Pick<DeviceDoc, 'name' | 'board' | 'lmsProgram' | 'capabilities' | 'status' | 'origin'> & { firmwareVersion?: string; chipId?: string; credentialsOwed?: boolean },
  ) => {
    const { firmwareVersion, chipId, credentialsOwed, ...rest } = set;
    const $set = { ...rest, ...(firmwareVersion ? { firmwareVersion } : {}), ...(chipId ? { chipId } : {}), ...(credentialsOwed ? { credentialsIssuedAt: null } : {}) };
    return dbOp(E, 'lmsSync', () =>
      DeviceModel.findByIdAndUpdate(oid(id), { $set, ...(firmwareVersion ? {} : { $unset: { firmwareVersion: 1 } }) }, { new: true, runValidators: true })
        .lean<DeviceDoc>()
        .exec(), { id });
  },

  /** Broker credentials for this device were issued (and returned to the LMS). */
  markCredentialsIssued: (id: string, at: Date) =>
    dbOp(E, 'markCredentialsIssued', () => DeviceModel.updateOne({ _id: oid(id) }, { $set: { credentialsIssuedAt: at } }).exec(), { id }),

  /** LMS B3: disabled, and its broker account is gone (a re-flash must issue new credentials). */
  lmsDisable: (id: string) =>
    dbOp(E, 'lmsDisable', () => DeviceModel.updateOne({ _id: oid(id) }, { $set: { status: 'disabled', credentialsIssuedAt: null } }).exec(), { id }),

  findById: (id: string) => dbOp(E, 'findById', () => DeviceModel.findById(oid(id)).lean<DeviceDoc>().exec(), { id }),

  rename: (id: string, ownerId: string, name: string) =>
    dbOp(E, 'rename', () => DeviceModel.findOneAndUpdate({ _id: oid(id), ownerId: oid(ownerId) }, { $set: { name } }, { new: true, runValidators: true }).lean<DeviceDoc>().exec(), { id }),

  setConnection: (id: string, state: ConnectionState, since: Date) =>
    dbOp(E, 'setConnection', () => DeviceModel.updateOne({ _id: oid(id) }, { $set: { connectionState: state, connectionSince: since } }, { timestamps: false }).exec(), { id, quiet: true }),

  touchLastSeen: (id: string, at: Date) =>
    dbOp(E, 'touchLastSeen', () => DeviceModel.updateOne({ _id: oid(id) }, { $max: { lastSeenAt: at } }, { timestamps: false }).exec(), { id, quiet: true }),

  existsHardwareOrPrefix: (hardwareId: string, topicPrefix: string, excludeId?: string) =>
    dbOp(E, 'existsHardwareOrPrefix', async () => {
      const filter: FilterQuery<DeviceDoc> = { $or: [{ hardwareId }, { topicPrefix }] };
      if (excludeId) filter._id = { $ne: oid(excludeId) };
      return Boolean(await DeviceModel.exists(filter).exec());
    }),

  deleteOwnedSimulated: (ownerId: string, session?: ClientSession) =>
    dbOp(E, 'deleteOwnedSimulated', () => DeviceModel.deleteMany({ ownerId: oid(ownerId), simulated: true }, { session }).exec()),

  /* ------------------------------------------------ admin (unscoped) */

  adminUpdate: (id: string, set: Partial<Pick<DeviceDoc, 'name' | 'ownerId' | 'status' | 'topicPrefix' | 'firmwareVersion'>>) =>
    dbOp(E, 'adminUpdate', () => DeviceModel.findByIdAndUpdate(oid(id), { $set: set }, { new: true, runValidators: true }).lean<DeviceDoc>().exec(), { id }),

  deleteById: (id: string) => dbOp(E, 'deleteById', () => DeviceModel.deleteOne({ _id: oid(id) }).exec(), { id }),

  paginateAll: (f: { q?: string; ownerId?: string; simulated?: boolean; status?: string }, page: number, pageSize: number, sort: { field: string; direction: 1 | -1 }): Promise<Page<DeviceDoc>> =>
    dbOp(E, 'paginateAll', async () => {
      const filter: FilterQuery<DeviceDoc> = {};
      if (f.ownerId) filter.ownerId = oid(f.ownerId);
      if (f.simulated !== undefined) filter.simulated = f.simulated;
      if (f.status) filter.status = f.status;
      if (f.q) filter.$or = [{ name: { $regex: f.q, $options: 'i' } }, { hardwareId: { $regex: f.q, $options: 'i' } }];
      const [items, total] = await Promise.all([
        DeviceModel.find(filter).sort({ [sort.field]: sort.direction as SortOrder, _id: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean<DeviceDoc[]>().exec(),
        DeviceModel.countDocuments(filter).exec(),
      ]);
      return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
    }),

  countByState: () =>
    dbOp(E, 'countByState', async () => {
      const rows = await DeviceModel.aggregate<{ _id: { simulated: boolean; state: string }; n: number }>([
        { $group: { _id: { simulated: '$simulated', state: '$connectionState' }, n: { $sum: 1 } } },
      ]).exec();
      return rows.map((r) => ({ simulated: r._id.simulated, state: r._id.state, count: r.n }));
    }),
};
