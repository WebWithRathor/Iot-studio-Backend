import { z } from 'zod';
import { LIMITS } from '../../constants/app.constants';
import { MESSAGE_KINDS, MQTT_LIMITS } from '../../constants/mqtt.constants';
import { validatePayload, validateTopic } from '../../utils/mqtt-topic.util';
import { objectId, sinceQuery } from '../shared/common.validation';

/** A command for a variable. The server resolves the topic — clients never choose it. */
export const commandBody = z
  .object({
    variableId: objectId,
    value: z.union([z.boolean(), z.number().finite(), z.string().max(256), z.record(z.unknown())]),
  })
  .strict();

/** Free-form console publish. Allowed only on topics the caller is authorised for (see mqtt.service). */
export const rawPublishBody = z
  .object({
    topic: z.string().trim().superRefine((t, ctx) => {
      const p = validateTopic(t);
      if (p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: p });
    }),
    payload: z
      .string()
      .max(MQTT_LIMITS.MAX_PAYLOAD_BYTES)
      .superRefine((p, ctx) => {
        const problem = validatePayload(p);
        if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
      }),
  })
  .strict();

const csvIds = z
  .string()
  .max(25 * 30)
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(objectId).max(25));

export const messagesQuery = z.object({
  deviceId: objectId.optional(),
  direction: z.enum(['in', 'out']).optional(),
  kind: z.enum(MESSAGE_KINDS).optional(),
  before: sinceQuery.optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.MAX_MESSAGES_PAGE).default(200),
});

export const telemetryQuery = z.object({
  variableIds: csvIds,
  since: sinceQuery.optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(600),
});

export const snapshotQuery = z.object({
  historyMinutes: z.coerce.number().int().min(1).max(60).default(LIMITS.SNAPSHOT_HISTORY_MINUTES),
});
