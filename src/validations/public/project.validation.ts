import { z } from 'zod';
import { DATA_TYPES, DIRECTIONS, LIMITS, PROJECT_ACCENTS, PROJECT_CATEGORIES, PROJECT_ICONS, WIDGET_TYPES } from '../../constants/app.constants';
import { longText, objectId, paginationQuery, searchQuery, sortParam, text } from '../shared/common.validation';
import { widgetConfig, widgetId, widgetLayout } from './widget.validation';

export const lmsProgramRef = z
  .object({
    programId: text(64, 1),
    name: text(120, 1),
    version: text(32).optional(),
    source: z.enum(['mock', 'lms']),
  })
  .strict();

const projectSettings = z
  .object({
    density: z.enum(['compact', 'comfortable']),
    showWidgetHeaders: z.boolean(),
  })
  .strict();

export const createProjectBody = z
  .object({
    name: text(60, 1),
    description: longText(500).default(''),
    category: z.enum(PROJECT_CATEGORIES).default('Custom'),
    icon: z.enum(PROJECT_ICONS).default('LuHouse'),
    accent: z.enum(PROJECT_ACCENTS).default('indigo'),
    deviceIds: z.array(objectId).max(20).default([]),
    lmsProgram: lmsProgramRef.nullable().default(null),
    importVariables: z.boolean().default(true),
  })
  .strict();

export const updateProjectBody = z
  .object({
    name: text(60, 1).optional(),
    description: longText(500).optional(),
    category: z.enum(PROJECT_CATEGORIES).optional(),
    icon: z.enum(PROJECT_ICONS).optional(),
    accent: z.enum(PROJECT_ACCENTS).optional(),
    settings: projectSettings.optional(),
    defaultDashboardId: objectId.optional(),
    lmsProgram: lmsProgramRef.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'send at least one field to update');

export const listProjectsQuery = paginationQuery.extend({
  q: searchQuery,
  category: z.enum(PROJECT_CATEGORIES).optional(),
  sort: sortParam(['updatedAt', 'createdAt', 'lastActivityAt', 'name'] as const, '-updatedAt'),
  pageSize: z.coerce.number().int().min(1).max(LIMITS.MAX_PROJECTS_PER_USER).default(LIMITS.MAX_PROJECTS_PER_USER),
});

export const projectDeviceParams = z.object({ id: objectId, deviceId: objectId }).strict();

export const projectActivityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  before: z.coerce.number().int().min(0).optional(),
});

/* ------------------------------------------------- import (export bundle) */

/**
 * Accepts the file produced by GET /projects/:id/export (and by the original
 * frontend prototype). Ids inside the bundle are only used to re-link
 * widgets to variables — they never address existing records.
 */
const looseId = z.string().min(1).max(64);

const importedVariable = z
  .object({
    id: looseId,
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    displayName: text(60, 1),
    dataType: z.enum(DATA_TYPES),
    direction: z.enum(DIRECTIONS),
    deviceId: looseId.nullable().optional(),
    stateTopic: z.string().max(200).optional(),
    commandTopic: z.string().max(200).optional(),
    unit: text(16).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .passthrough();

const importedWidget = z
  .object({
    id: widgetId,
    type: z.enum(WIDGET_TYPES),
    layout: widgetLayout,
    config: widgetConfig,
    binding: z.object({ variableId: looseId, scale: z.number().finite().optional(), offset: z.number().finite().optional() }).strict().nullable(),
  })
  .strict();

export const importProjectBody = z
  .object({
    kind: z.literal('kokoon-iot-studio/project'),
    version: z.literal(1),
    exportedAt: z.string().max(40).optional(),
    project: z
      .object({
        name: text(60, 1),
        description: longText(500).default(''),
        category: z.enum(PROJECT_CATEGORIES).catch('Custom'),
        icon: z.enum(PROJECT_ICONS).catch('LuHouse'),
        accent: z.enum(PROJECT_ACCENTS).catch('indigo'),
        settings: projectSettings.optional(),
        defaultDashboardId: looseId.optional(),
        lmsProgram: lmsProgramRef.nullable().optional(),
      })
      .passthrough(),
    dashboards: z
      .array(z.object({ id: looseId, name: text(60, 1), widgets: z.array(importedWidget).max(LIMITS.MAX_WIDGETS_PER_DASHBOARD) }).passthrough())
      .min(1)
      .max(LIMITS.MAX_DASHBOARDS_PER_PROJECT),
    variables: z.array(importedVariable).max(LIMITS.MAX_VARIABLES_PER_PROJECT).default([]),
    devices: z.array(z.object({ id: looseId, name: z.string().max(80), hardwareId: z.string().max(64) }).strict()).max(50).default([]),
  })
  .strict();

export type ImportProjectInput = z.infer<typeof importProjectBody>;
