import { Schema, model, type Types } from 'mongoose';
import { ALL_PLANS, DEFAULT_PLAN, MAX_BONUS_TOKENS, type Plan } from '../constants/plans.constants';
import { ALL_ROLES, DEFAULT_ROLE, type Role } from '../constants/roles.constants';
import type { AccountStatus, UserPreferences } from '../types/user.types';

export interface UserDoc {
  _id: Types.ObjectId;
  email: string;
  name: string;
  /** scrypt/argon2 hash — never selected by default, never returned to clients. */
  passwordHash: string;
  role: Role;
  status: AccountStatus;
  /** Incremented on role change, disable, password change → invalidates outstanding access tokens. */
  tokenVersion: number;
  preferences: UserPreferences;
  /** Billing plan → token allowance. Older documents may lack it: read with `?? DEFAULT_PLAN`. */
  plan: Plan;
  /** Extra tokens on top of the plan allowance (admin grants, additional kits). */
  bonusTokens: number;
  lastLoginAt: Date | null;
  /** How the account was created: local sign-up / admin, or first sign-in from the Kokoon LMS. */
  authProvider: 'local' | 'lms';
  /** Stable user id in the Kokoon LMS (`sub` of its SSO tokens). Null for accounts never linked to the LMS. */
  lmsUserId: string | null;
  /** False for LMS-created accounts until the user chooses a password (password sign-in is refused until then). */
  passwordSet: boolean;
  failedLogins: number;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ALL_ROLES, default: DEFAULT_ROLE, required: true },
    status: { type: String, enum: ['active', 'disabled'], default: 'active', required: true },
    tokenVersion: { type: Number, default: 0, min: 0 },
    preferences: {
      onboardingDismissed: { type: Boolean, default: false },
    },
    plan: { type: String, enum: ALL_PLANS, default: DEFAULT_PLAN },
    bonusTokens: { type: Number, default: 0, min: 0, max: MAX_BONUS_TOKENS },
    lastLoginAt: { type: Date, default: null },
    authProvider: { type: String, enum: ['local', 'lms'], default: 'local' },
    lmsUserId: { type: String, default: null, maxlength: 128 },
    passwordSet: { type: Boolean, default: true },
    failedLogins: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, default: null, select: false },
  },
  { timestamps: true, strict: 'throw', collection: 'users' },
);

userSchema.index({ email: 1 }, { unique: true, name: 'uniq_email' });
userSchema.index({ lmsUserId: 1 }, { unique: true, name: 'uniq_lms_user', partialFilterExpression: { lmsUserId: { $type: 'string' } } });
userSchema.index({ role: 1, status: 1 }, { name: 'role_status' });
userSchema.index({ createdAt: -1 }, { name: 'created_desc' });

export const UserModel = model<UserDoc>('User', userSchema);
