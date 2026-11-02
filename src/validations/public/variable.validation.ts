import { z } from 'zod';
import { DATA_TYPES, DIRECTIONS } from '../../constants/app.constants';
import { validateTopic } from '../../utils/mqtt-topic.util';
import { finite, objectId, text } from '../shared/common.validation';

export const variableKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'use lowercase letters, digits and “_”, starting with a letter (e.g. led_state)');

const topic = z.string().trim().superRefine((t, ctx) => {
  const problem = validateTopic(t);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
});

const variableFields = {
  key: variableKey,
  displayName: text(60, 1),
  dataType: z.enum(DATA_TYPES),
  direction: z.enum(DIRECTIONS),
  deviceId: objectId.nullable(),
  stateTopic: topic.optional(),
  commandTopic: topic.optional(),
  unit: text(16).optional(),
  min: finite.optional(),
  max: finite.optional(),
};

const checkShape = <T extends { direction: string; stateTopic?: string; commandTopic?: string; min?: number; max?: number }>(v: T, ctx: z.RefinementCtx) => {
  if (v.direction !== 'command' && !v.stateTopic) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stateTopic'], message: 'is required for telemetry and two-way variables' });
  if (v.direction !== 'telemetry' && !v.commandTopic) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['commandTopic'], message: 'is required for command and two-way variables' });
  if (v.stateTopic && v.commandTopic && v.stateTopic === v.commandTopic) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['commandTopic'], message: 'must differ from the state topic' });
  if (v.min !== undefined && v.max !== undefined && v.min >= v.max) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['max'], message: 'must be greater than min' });
};

export const createVariableBody = z.object(variableFields).strict().superRefine(checkShape);

/** Full replacement of the editable fields (the frontend form always sends all of them). */
export const updateVariableBody = createVariableBody;

export const importVariableBody = z.object({ deviceId: objectId, key: variableKey }).strict();
