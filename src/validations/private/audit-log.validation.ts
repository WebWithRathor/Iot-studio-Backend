import { z } from 'zod';
import { objectId, paginationQuery, sinceQuery, text } from '../shared/common.validation';

export const listAuditLogsQuery = paginationQuery.extend({
  actorId: objectId.optional(),
  targetId: text(64).optional(),
  action: z.string().regex(/^[a-z_.]{2,60}$/).optional(),
  outcome: z.enum(['success', 'failure', 'denied']).optional(),
  from: sinceQuery.optional(),
  to: sinceQuery.optional(),
});
