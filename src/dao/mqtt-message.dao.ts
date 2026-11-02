import type { FilterQuery, Types } from 'mongoose';
import { MqttMessageModel, type MqttMessageDoc } from '../models/mqtt-message.model';
import type { MessageKind, MessageStatus } from '../constants/mqtt.constants';
import { dbOp } from '../utils/logger.util';
import { oid } from '../utils/id.util';

const E = 'MqttMessage';

export interface MessageListFilter {
  ownerId?: string;
  deviceId?: string;
  deviceIds?: string[];
  direction?: 'in' | 'out';
  kind?: MessageKind;
  before?: number;
  limit: number;
}

function filterOf(f: MessageListFilter): FilterQuery<MqttMessageDoc> {
  const q: FilterQuery<MqttMessageDoc> = {};
  if (f.ownerId) q.ownerId = oid(f.ownerId);
  if (f.deviceId) q.deviceId = oid(f.deviceId);
  else if (f.deviceIds) q.deviceId = { $in: f.deviceIds.map(oid) };
  if (f.direction) q.direction = f.direction;
  if (f.kind) q.kind = f.kind;
  if (f.before) q.at = { $lt: new Date(f.before) };
  return q;
}

export const mqttMessageDao = {
  /** Batched insert used by the ingestion buffer (logged only when slow or failing). */
  insertMany: (docs: Array<Omit<MqttMessageDoc, '_id'> & { _id: Types.ObjectId }>) =>
    dbOp(E, 'insertMany', () => MqttMessageModel.insertMany(docs, { ordered: false, lean: true }).then((r) => r.length), { quiet: true }),

  setStatus: (id: Types.ObjectId | string, status: MessageStatus) =>
    dbOp(E, 'setStatus', () => MqttMessageModel.updateOne({ _id: typeof id === 'string' ? oid(id) : id }, { $set: { status } }).exec(), { id: String(id), quiet: true }),

  /** Newest first. */
  list: (f: MessageListFilter) =>
    dbOp(E, 'list', () => MqttMessageModel.find(filterOf(f)).sort({ at: -1 }).limit(f.limit).lean<MqttMessageDoc[]>().exec()),

  /** Numeric telemetry samples for the given topics since a time, oldest first. Owner-scoped. */
  telemetry: (ownerId: string, topics: string[], since: Date, limit: number) =>
    dbOp(E, 'telemetry', () =>
      MqttMessageModel.find({ ownerId: oid(ownerId), topic: { $in: topics }, direction: 'in', kind: 'telemetry', num: { $ne: null }, at: { $gte: since } })
        .select({ topic: 1, num: 1, at: 1, _id: 0 })
        .sort({ at: -1 })
        .limit(limit)
        .lean<Array<Pick<MqttMessageDoc, 'topic' | 'num' | 'at'>>>()
        .exec()
        .then((rows) => rows.reverse())),

  countSince: (since: Date) => dbOp(E, 'countSince', () => MqttMessageModel.countDocuments({ at: { $gte: since } }).exec()),

  deleteByOwnerDevices: (deviceIds: Types.ObjectId[]) =>
    dbOp(E, 'deleteByOwnerDevices', () => MqttMessageModel.deleteMany({ deviceId: { $in: deviceIds } }).exec()),
};
