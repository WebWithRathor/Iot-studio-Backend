import { z } from 'zod';
import { GRID_COLS, GRID_MAX_H, GRID_MAX_ROWS, PROJECT_ACCENTS, WIDGET_TYPES } from '../../constants/app.constants';
import { finite, objectId, text } from '../shared/common.validation';

/**
 * One validated representation for all 24 widget types (the frontend uses a
 * shared config object, see src/types/models.ts WidgetConfig). Every key is
 * typed and bounded; unknown keys are rejected.
 */

export const widgetId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be a valid widget id');

export const widgetLayout = z
  .object({
    x: z.number().int().min(0).max(GRID_COLS - 1),
    y: z.number().int().min(0).max(GRID_MAX_ROWS),
    w: z.number().int().min(1).max(GRID_COLS),
    h: z.number().int().min(1).max(GRID_MAX_H),
  })
  .strict()
  .refine((l) => l.x + l.w <= GRID_COLS, 'widget must fit inside the 12-column grid');

const optText = (max: number) => text(max).optional();

export const widgetConfig = z
  .object({
    title: text(80),
    description: optText(200),
    showHeader: z.boolean().optional(),
    visible: z.boolean().optional(),
    color: z.enum(PROJECT_ACCENTS).optional(),
    label: optText(60),
    unit: optText(16),
    precision: z.number().int().min(0).max(6).optional(),
    min: finite.optional(),
    max: finite.optional(),
    step: finite.positive().optional(),
    defaultValue: finite.optional(),
    onValue: optText(64),
    offValue: optText(64),
    onLabel: optText(32),
    offLabel: optText(32),
    pressValue: optText(64),
    timeWindow: z.number().int().refine((v) => [30, 60, 300, 900].includes(v), 'must be 30, 60, 300 or 900').optional(),
    samples: z.number().int().min(2).max(60).optional(),
    text: z.string().max(500).optional(),
    align: z.enum(['left', 'center']).optional(),
    size: z.enum(['sm', 'md', 'lg']).optional(),
    deviceId: objectId.optional(),
    source: z.enum(['variable', 'messages']).optional(),
    thresholdLow: finite.optional(),
    thresholdHigh: finite.optional(),
    /** Mode selector options: "Label=value, Label=value" (or just "A, B, C"). */
    choices: optText(300),
  })
  .strict()
  .refine((c) => c.min === undefined || c.max === undefined || c.min < c.max, { message: 'max must be greater than min', path: ['max'] });

export const binding = z
  .object({
    variableId: objectId,
    scale: finite.optional(),
    offset: finite.optional(),
  })
  .strict();

export const widget = z
  .object({
    id: widgetId,
    type: z.enum(WIDGET_TYPES),
    layout: widgetLayout,
    config: widgetConfig,
    binding: binding.nullable(),
  })
  .strict();

export type WidgetInput = z.infer<typeof widget>;

export const widgetParams = z.object({ id: objectId, widgetId }).strict();

export const createWidgetBody = widget;

export const updateWidgetBody = z
  .object({
    layout: widgetLayout.optional(),
    config: widgetConfig.optional(),
    binding: binding.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'send at least one of layout, config, binding');
