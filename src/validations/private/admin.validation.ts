import { z } from 'zod';

/** GET /admin/overview — window for "recent" counters. */
/** PATCH /admin/settings — the switches on the admin panel. */
export const appSettingsBody = z
  .object({ tokensEnabled: z.boolean().optional() })
  .strict()
  .refine((v) => v.tokensEnabled !== undefined, 'send at least one setting');

export const overviewQuery = z.object({
  hours: z.coerce.number().int().min(1).max(24 * 30).default(24),
});
