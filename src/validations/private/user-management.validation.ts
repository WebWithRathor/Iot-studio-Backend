import { z } from 'zod';
import { ALL_PLANS, MAX_BONUS_TOKENS, type Plan } from '../../constants/plans.constants';
import { ALL_ROLES, type Role } from '../../constants/roles.constants';
import { longText, paginationQuery, searchQuery, sortParam } from '../shared/common.validation';

export const listUsersQuery = paginationQuery.extend({
  q: searchQuery,
  role: z.enum(ALL_ROLES as [Role, ...Role[]]).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  sort: sortParam(['createdAt', 'email', 'name', 'lastLoginAt'] as const, '-createdAt'),
});

export const changeRoleBody = z
  .object({
    role: z.enum(ALL_ROLES as [Role, ...Role[]]),
    reason: longText(300).optional(),
  })
  .strict();

export const changePlanBody = z
  .object({
    plan: z.enum(ALL_PLANS as [Plan, ...Plan[]]).optional(),
    bonusTokens: z.number().int().min(0).max(MAX_BONUS_TOKENS).optional(),
    reason: longText(300).optional(),
  })
  .strict()
  .refine((v) => v.plan !== undefined || v.bonusTokens !== undefined, 'send plan and/or bonusTokens');

export const changeStatusBody = z
  .object({
    status: z.enum(['active', 'disabled']),
    reason: longText(300).optional(),
  })
  .strict();
