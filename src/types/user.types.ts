import type { Role } from '../constants/roles.constants';
import type { Permission } from '../constants/permissions.constants';
import type { Plan } from '../constants/plans.constants';

export type AccountStatus = 'active' | 'disabled';

export interface UserPreferences {
  onboardingDismissed: boolean;
}

/** Shape returned to the browser. Matches the frontend `User` model plus role/permissions. */
export interface UserDTO {
  id: string;
  name: string;
  email: string;
  role: Role;
  permissions: Permission[];
  initials: string;
  status: AccountStatus;
  /** 'lms' = the account was created by signing in from the Kokoon LMS. */
  source: 'local' | 'lms';
  /** False while an LMS-created account has no password of its own (password sign-in is off). */
  passwordSet: boolean;
  preferences: UserPreferences;
  plan: Plan;
  createdAt: number;
  lastLoginAt: number | null;
}

/** Admin view of a user. */
export interface ManagedUserDTO extends UserDTO {
  updatedAt: number;
  projectCount?: number;
  deviceCount?: number;
  bonusTokens: number;
  /** Kokoon LMS user id, when the account is linked to the LMS. */
  lmsUserId: string | null;
  /** plan allowance + bonus */
  tokenAllowance: number;
  /** Only on the single-user view (it is computed from the workspace). */
  tokensUsed?: number;
}
