import { z } from 'zod';
import { DATA_TYPES, DIRECTIONS } from '../../constants/app.constants';
import { isReservedHardwareId } from '../../config/lms.config';
import { DEVICE_BOARDS } from '../../constants/mqtt.constants';
import { HARDWARE_ID } from '../../utils/mqtt-topic.util';
import { variableKey } from '../public/variable.validation';
import { email, finite, text } from '../shared/common.validation';

/** Request schemas for the LMS → IoT Studio API (contract B, docs/LMS-INTEGRATION.md). */

export const MAX_LMS_VARIABLES = 30;
export const MAX_LMS_STATUS_IDS = 200;

/** The board's machine.unique_id() as lowercase hex (ESP32 MAC-derived, 6–16 bytes). */
export const CHIP_ID = /^[0-9a-f]{8,32}$/;

export const lmsHardwareId = z
  .string()
  .regex(HARDWARE_ID, 'use 3–48 lowercase letters, digits and “-”, starting with a letter or digit')
  // Static prefixes only; the backend's own broker account names are checked by the controller (they come from the env).
  .refine((h) => !isReservedHardwareId(h), 'this hardware id prefix is reserved');

/** A firmware variable declared by an LMS "declare IoT variable" block. Custom keys are allowed (not just the 15 presets). */
export const lmsVariable = z
  .object({
    key: variableKey,
    displayName: text(60, 1),
    dataType: z.enum(DATA_TYPES),
    direction: z.enum(DIRECTIONS),
    unit: text(16).optional(),
    min: finite.optional(),
    max: finite.optional(),
    blockId: text(128, 1),
  })
  .strict()
  .refine((v) => v.min === undefined || v.max === undefined || v.min <= v.max, { message: 'min must be ≤ max', path: ['max'] });

export type LmsVariableInput = z.infer<typeof lmsVariable>;

export const lmsUpsertDeviceBody = z
  .object({
    user: z
      .object({
        lmsUserId: text(128, 1),
        email,
        emailVerified: z.boolean(),
        name: text(80, 1),
      })
      .strict(),
    device: z
      .object({
        name: text(60, 1),
        board: z.enum(DEVICE_BOARDS),
        firmwareVersion: text(40).optional(),
        chipId: z.string().regex(CHIP_ID, 'use the board’s unique id as 8–32 lowercase hex characters').optional(),
      })
      .strict(),
    program: z
      .object({
        programId: text(64, 1),
        name: text(120, 1),
        version: text(32).optional(),
      })
      .strict(),
    variables: z
      .array(lmsVariable)
      .max(MAX_LMS_VARIABLES, `a device can declare at most ${MAX_LMS_VARIABLES} variables`)
      .default([])
      .superRefine((vars, ctx) => {
        const seen = new Set<string>();
        vars.forEach((v, i) => {
          if (seen.has(v.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'key'], message: `“${v.key}” is declared twice` });
          seen.add(v.key);
        });
      }),
    project: z.object({ create: z.boolean() }).strict().default({ create: false }),
  })
  .strict();

export type LmsUpsertDeviceInput = z.infer<typeof lmsUpsertDeviceBody>;

const queryBool = z.enum(['true', 'false']).transform((v) => v === 'true').optional();

export const lmsUpsertQuery = z.object({
  rotateCredentials: queryBool,
  /** Bind a different physical chip to this hardware id (rotates the broker credentials). */
  replaceChip: queryBool,
});

/** Bulk status: plain hardware-id format (unknown or reserved ids are just reported as missing). */
export const lmsBulkStatusBody = z
  .object({
    hardwareIds: z
      .array(z.string().regex(HARDWARE_ID, 'use 3–48 lowercase letters, digits and “-”, starting with a letter or digit'))
      .min(1, 'send at least one hardware id')
      .max(MAX_LMS_STATUS_IDS, `send at most ${MAX_LMS_STATUS_IDS} hardware ids per request`),
  })
  .strict();

export type LmsBulkStatusInput = z.infer<typeof lmsBulkStatusBody>;
