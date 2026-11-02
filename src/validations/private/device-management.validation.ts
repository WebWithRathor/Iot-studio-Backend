import { z } from 'zod';
import { CAPABILITIES, DEVICE_BOARDS } from '../../constants/mqtt.constants';
import { HARDWARE_ID, validateTopic } from '../../utils/mqtt-topic.util';
import { longText, objectId, paginationQuery, searchQuery, sortParam, text } from '../shared/common.validation';
import { lmsProgramRef } from '../public/project.validation';

const capabilityKeys = Object.keys(CAPABILITIES) as [string, ...string[]];

const topicPrefix = z.string().trim().superRefine((t, ctx) => {
  const p = validateTopic(t);
  if (p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: p });
});

export const adminListDevicesQuery = paginationQuery.extend({
  q: searchQuery,
  ownerId: objectId.optional(),
  simulated: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  status: z.enum(['active', 'disabled']).optional(),
  sort: sortParam(['createdAt', 'name', 'hardwareId', 'lastSeenAt'] as const, '-createdAt'),
});

/** Register a REAL device (e.g. an ESP32 flashed from the LMS) and assign it to a user. */
export const registerDeviceBody = z
  .object({
    ownerId: objectId,
    name: text(60, 1),
    hardwareId: z.string().regex(HARDWARE_ID, 'use 3–48 lowercase letters, digits and “-”'),
    board: z.enum(DEVICE_BOARDS),
    firmwareVersion: text(40).optional(),
    capabilities: z.array(z.enum(capabilityKeys)).max(30).default([]),
    /** Defaults to {MQTT_TOPIC_ROOT}/{hardwareId}. Set it when the firmware uses another namespace. */
    topicPrefix: topicPrefix.optional(),
    lmsProgram: lmsProgramRef.nullable().default(null),
    reason: longText(300).optional(),
  })
  .strict();

export const adminUpdateDeviceBody = z
  .object({
    name: text(60, 1).optional(),
    ownerId: objectId.optional(),
    status: z.enum(['active', 'disabled']).optional(),
    topicPrefix: topicPrefix.optional(),
    firmwareVersion: text(40).optional(),
    reason: longText(300).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).filter((k) => k !== 'reason').length > 0, 'send at least one field to update');
