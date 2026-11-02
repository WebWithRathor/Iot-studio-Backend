import { z } from 'zod';
import { ALL_PLANS, MAX_BONUS_TOKENS, PLANS, type Plan } from '../../constants/plans.constants';
import { paginationQuery, text } from '../shared/common.validation';

export const listKitCodesQuery = paginationQuery.extend({
  status: z.enum(['redeemed', 'unused']).optional(),
});

export const generateKitCodesBody = z
  .object({
    count: z.number().int().min(1).max(100),
    plan: z.enum(ALL_PLANS as [Plan, ...Plan[]]).default(PLANS.PREMIUM),
    bonusTokens: z.number().int().min(0).max(MAX_BONUS_TOKENS).default(0),
    note: text(120).default(''),
  })
  .strict();
