import { z } from 'zod';

/** GET /admin/overview — window for "recent" counters. */
export const overviewQuery = z.object({
  hours: z.coerce.number().int().min(1).max(24 * 30).default(24),
});
