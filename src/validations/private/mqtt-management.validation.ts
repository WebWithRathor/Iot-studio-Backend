import { z } from 'zod';
import { LIMITS } from '../../constants/app.constants';
import { MESSAGE_KINDS } from '../../constants/mqtt.constants';
import { objectId, sinceQuery } from '../shared/common.validation';

export const simulationSettingsBody = z
  .object({
    paused: z.boolean().optional(),
    intervalMs: z.union([z.literal(1000), z.literal(2000), z.literal(5000)]).optional(),
  })
  .strict()
  .refine((v) => v.paused !== undefined || v.intervalMs !== undefined, 'send paused and/or intervalMs');

export const adminMessagesQuery = z.object({
  deviceId: objectId.optional(),
  ownerId: objectId.optional(),
  kind: z.enum(MESSAGE_KINDS).optional(),
  direction: z.enum(['in', 'out']).optional(),
  before: sinceQuery.optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.MAX_MESSAGES_PAGE).default(200),
});
