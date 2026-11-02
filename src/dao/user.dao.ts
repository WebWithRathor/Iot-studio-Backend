import type { ClientSession, FilterQuery, SortOrder } from 'mongoose';
import { UserModel, type UserDoc } from '../models/user.model';
import type { Role } from '../constants/roles.constants';
import type { Page } from '../types/common.types';
import { dbOp } from '../utils/logger.util';
import { oid } from '../utils/id.util';

const E = 'User';
export type UserRecord = Omit<UserDoc, 'passwordHash' | 'failedLogins' | 'lockedUntil'>;
export type UserWithSecrets = UserDoc;

export interface UserListFilter {
  q?: string; // already regex-escaped by the service
  role?: Role;
  status?: 'active' | 'disabled';
}

function buildFilter(f: UserListFilter): FilterQuery<UserDoc> {
  const filter: FilterQuery<UserDoc> = {};
  if (f.role) filter.role = f.role;
  if (f.status) filter.status = f.status;
  if (f.q) filter.$or = [{ email: { $regex: f.q, $options: 'i' } }, { name: { $regex: f.q, $options: 'i' } }];
  return filter;
}

export const userDao = {
  create: (data: Pick<UserDoc, 'email' | 'name' | 'passwordHash' | 'role'>, session?: ClientSession) =>
    dbOp(E, 'create', async () => {
      const [doc] = await UserModel.create([data], { session });
      const { passwordHash: _p, ...rest } = doc.toObject();
      return rest as UserRecord;
    }),

  /** First sign-in from the Kokoon LMS: the password hash is random and unusable (`passwordSet: false`). */
  createFromLms: (data: Pick<UserDoc, 'email' | 'name' | 'passwordHash' | 'role' | 'lmsUserId'>) =>
    dbOp(E, 'createFromLms', async () => {
      const [doc] = await UserModel.create([{ ...data, authProvider: 'lms', passwordSet: false }]);
      const { passwordHash: _p, ...rest } = doc.toObject();
      return rest as UserRecord;
    }),

  findByLmsUserId: (lmsUserId: string) => dbOp(E, 'findByLmsUserId', () => UserModel.findOne({ lmsUserId }).lean<UserRecord>().exec()),

  /** LMS ids of many users in one query (LMS bulk device status). */
  findLmsIds: (ids: string[]) =>
    dbOp(E, 'findLmsIds', () => UserModel.find({ _id: { $in: ids.map(oid) } }).select('lmsUserId').lean<Pick<UserDoc, '_id' | 'lmsUserId'>[]>().exec(), { quiet: true }),

  /** Link an existing account to an LMS identity. Only succeeds while the account has no LMS id yet. */
  linkLms: (id: string, lmsUserId: string) =>
    dbOp(E, 'linkLms', () => UserModel.findOneAndUpdate({ _id: oid(id), lmsUserId: null }, { $set: { lmsUserId } }, { new: true }).lean<UserRecord>().exec(), { id }),

  findById: (id: string, session?: ClientSession) =>
    dbOp(E, 'findById', () => UserModel.findById(oid(id)).session(session ?? null).lean<UserRecord>().exec(), { id }),

  findByEmail: (email: string) => dbOp(E, 'findByEmail', () => UserModel.findOne({ email }).lean<UserRecord>().exec()),

  /** Only for credential checks — includes the password hash and lockout counters. */
  findByEmailWithSecrets: (email: string) =>
    dbOp(E, 'findByEmailWithSecrets', () => UserModel.findOne({ email }).select('+passwordHash +failedLogins +lockedUntil').lean<UserWithSecrets>().exec()),

  findByIdWithSecrets: (id: string) =>
    dbOp(E, 'findByIdWithSecrets', () => UserModel.findById(oid(id)).select('+passwordHash').lean<UserWithSecrets>().exec(), { id }),

  /** Minimal fields needed to authorise a request. */
  findAuthState: (id: string) =>
    dbOp(E, 'findAuthState', () => UserModel.findById(oid(id)).select('role status tokenVersion email name').lean<Pick<UserDoc, '_id' | 'role' | 'status' | 'tokenVersion' | 'email' | 'name'>>().exec(), { id, quiet: true }),

  updateProfile: (id: string, set: Partial<Pick<UserDoc, 'name'>>) =>
    dbOp(E, 'updateProfile', () => UserModel.findByIdAndUpdate(oid(id), { $set: set }, { new: true, runValidators: true }).lean<UserRecord>().exec(), { id }),

  updatePreferences: (id: string, prefs: Partial<UserDoc['preferences']>) => {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(prefs)) if (v !== undefined) set[`preferences.${k}`] = v;
    return dbOp(E, 'updatePreferences', () => UserModel.findByIdAndUpdate(oid(id), { $set: set }, { new: true }).lean<UserRecord>().exec(), { id });
  },

  setPasswordHash: (id: string, passwordHash: string) =>
    dbOp(E, 'setPasswordHash', () => UserModel.findByIdAndUpdate(oid(id), { $set: { passwordHash, passwordSet: true }, $inc: { tokenVersion: 1 } }, { new: true }).lean<UserRecord>().exec(), { id }),

  recordLoginSuccess: (id: string) =>
    dbOp(E, 'recordLoginSuccess', () => UserModel.updateOne({ _id: oid(id) }, { $set: { lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null } }).exec(), { id }),

  recordLoginFailure: (id: string, lockAfter: number, lockMinutes: number) =>
    dbOp(E, 'recordLoginFailure', async () => {
      const doc = await UserModel.findByIdAndUpdate(oid(id), { $inc: { failedLogins: 1 } }, { new: true }).select('+failedLogins').lean<UserWithSecrets>().exec();
      if (doc && doc.failedLogins >= lockAfter) {
        await UserModel.updateOne({ _id: doc._id }, { $set: { lockedUntil: new Date(Date.now() + lockMinutes * 60_000), failedLogins: 0 } }).exec();
        return { locked: true };
      }
      return { locked: false };
    }, { id }),

  setRole: (id: string, role: Role) =>
    dbOp(E, 'setRole', () => UserModel.findByIdAndUpdate(oid(id), { $set: { role }, $inc: { tokenVersion: 1 } }, { new: true }).lean<UserRecord>().exec(), { id }),

  /** Plan / bonus changes do not touch tokenVersion: they never affect authorisation. */
  setPlan: (id: string, set: Partial<Pick<UserDoc, 'plan' | 'bonusTokens'>>, session?: ClientSession) =>
    dbOp(E, 'setPlan', () => UserModel.findByIdAndUpdate(oid(id), { $set: set }, { new: true, runValidators: true, session }).lean<UserRecord>().exec(), { id }),

  setStatus: (id: string, status: 'active' | 'disabled') =>
    dbOp(E, 'setStatus', () => UserModel.findByIdAndUpdate(oid(id), { $set: { status }, $inc: { tokenVersion: 1 } }, { new: true }).lean<UserRecord>().exec(), { id }),

  paginate: (f: UserListFilter, page: number, pageSize: number, sort: { field: string; direction: 1 | -1 }): Promise<Page<UserRecord>> =>
    dbOp(E, 'paginate', async () => {
      const filter = buildFilter(f);
      const [items, total] = await Promise.all([
        UserModel.find(filter).sort({ [sort.field]: sort.direction as SortOrder, _id: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean<UserRecord[]>().exec(),
        UserModel.countDocuments(filter).exec(),
      ]);
      return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
    }),

  countByRole: () =>
    dbOp(E, 'countByRole', async () => {
      const rows = await UserModel.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$role', n: { $sum: 1 } } }]).exec();
      return Object.fromEntries(rows.map((r) => [r._id, r.n])) as Record<string, number>;
    }),

  countSince: (since: Date) => dbOp(E, 'countSince', () => UserModel.countDocuments({ createdAt: { $gte: since } }).exec()),

  countByRoleExact: (role: Role, status: 'active' | 'disabled' = 'active') => dbOp(E, 'countByRoleExact', () => UserModel.countDocuments({ role, status }).exec()),
};
