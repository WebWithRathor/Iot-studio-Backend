import type { ClientSession, Types } from 'mongoose';
import { KitCodeModel, type KitCodeDoc } from '../models/kit-code.model';
import type { Page } from '../types/common.types';
import { dbOp } from '../utils/logger.util';
import { oid } from '../utils/id.util';

const E = 'KitCode';

export const kitCodeDao = {
  createMany: (docs: Array<Pick<KitCodeDoc, 'codeHash' | 'last4' | 'plan' | 'bonusTokens' | 'note'> & { createdBy: Types.ObjectId }>) =>
    dbOp(E, 'createMany', async () => (await KitCodeModel.insertMany(docs)).map((d) => d.toObject() as KitCodeDoc)),

  /** Atomically claim an unredeemed code. Null when it does not exist or was already used. */
  claim: (codeHash: string, userId: string, session?: ClientSession) =>
    dbOp(E, 'claim', () =>
      KitCodeModel.findOneAndUpdate({ codeHash, redeemedBy: null }, { $set: { redeemedBy: oid(userId), redeemedAt: new Date() } }, { new: true, session }).lean<KitCodeDoc>().exec()),

  /** Undo a claim (only used when a non-transactional redemption fails half-way). */
  release: (codeHash: string, userId: string) =>
    dbOp(E, 'release', () => KitCodeModel.updateOne({ codeHash, redeemedBy: oid(userId) }, { $set: { redeemedBy: null, redeemedAt: null } }).exec()),

  paginate: (f: { status?: 'redeemed' | 'unused' }, page: number, pageSize: number): Promise<Page<KitCodeDoc>> =>
    dbOp(E, 'paginate', async () => {
      const filter = f.status === 'redeemed' ? { redeemedBy: { $ne: null } } : f.status === 'unused' ? { redeemedBy: null } : {};
      const [items, total] = await Promise.all([
        KitCodeModel.find(filter).sort({ createdAt: -1, _id: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean<KitCodeDoc[]>().exec(),
        KitCodeModel.countDocuments(filter).exec(),
      ]);
      return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
    }),
};
