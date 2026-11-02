import { RefreshSessionModel, type RefreshSessionDoc } from '../models/refresh-session.model';
import { dbOp } from '../utils/logger.util';
import { oid } from '../utils/id.util';

const E = 'RefreshSession';

export const refreshSessionDao = {
  create: (data: Pick<RefreshSessionDoc, 'sid' | 'userId' | 'currentJtiHash' | 'clientInfoEnc' | 'expiresAt'>) =>
    dbOp(E, 'create', async () => (await RefreshSessionModel.create(data)).toObject() as RefreshSessionDoc, { id: data.sid }),

  findBySid: (sid: string) => dbOp(E, 'findBySid', () => RefreshSessionModel.findOne({ sid }).lean<RefreshSessionDoc>().exec(), { id: sid }),

  /** Compare-and-swap rotation: only succeeds if the presented jti is still current. */
  rotate: (sid: string, expectedHash: string, newHash: string) =>
    dbOp(E, 'rotate', () =>
      RefreshSessionModel.findOneAndUpdate(
        { sid, currentJtiHash: expectedHash, revokedAt: null },
        { $set: { currentJtiHash: newHash, lastRotatedAt: new Date() }, $inc: { rotations: 1 } },
        { new: true },
      ).lean<RefreshSessionDoc>().exec(), { id: sid }),

  revoke: (sid: string, reason: string) =>
    dbOp(E, 'revoke', () => RefreshSessionModel.updateOne({ sid, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: reason } }).exec(), { id: sid }),

  /** Revoke every active session of a user; returns their sids so Redis can be cleared too. */
  revokeAllForUser: (userId: string, reason: string) =>
    dbOp(E, 'revokeAllForUser', async () => {
      const active = await RefreshSessionModel.find({ userId: oid(userId), revokedAt: null, expiresAt: { $gt: new Date() } }).select('sid').lean<Array<{ sid: string }>>().exec();
      if (active.length) await RefreshSessionModel.updateMany({ sid: { $in: active.map((a) => a.sid) } }, { $set: { revokedAt: new Date(), revokeReason: reason } }).exec();
      return active.map((a) => a.sid);
    }, { id: userId }),

  listForUser: (userId: string, limit = 20) =>
    dbOp(E, 'listForUser', () => RefreshSessionModel.find({ userId: oid(userId) }).sort({ createdAt: -1 }).limit(limit).lean<RefreshSessionDoc[]>().exec(), { id: userId }),

  /** Housekeeping: revoked sessions are kept 7 days for review, then removed (expired ones go via TTL). */
  deleteRevokedBefore: (before: Date) =>
    dbOp(E, 'deleteRevokedBefore', () => RefreshSessionModel.deleteMany({ revokedAt: { $ne: null, $lt: before } }).exec()),

  countActive: () => dbOp(E, 'countActive', () => RefreshSessionModel.countDocuments({ revokedAt: null, expiresAt: { $gt: new Date() } }).exec()),
};
