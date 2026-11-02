import { z } from 'zod';
import { LIMITS } from '../../constants/app.constants';

/**
 * Shared primitives only. Input policy used across all schemas:
 *   - bodies and route params are `.strict()`: unknown fields → 400 VALIDATION_ERROR
 *   - query strings are stripped: unknown keys are ignored and never reach a query
 * Database filters are always built from the parsed output, never from raw input.
 */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a valid id');

/** Trimmed single-line text without control characters. */
export const text = (max: number, min = 0) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !CONTROL.test(s) && !/[\r\n]/.test(s), 'must be a single line of plain text');

/** Multi-line text (descriptions). */
export const longText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !CONTROL.test(s), 'contains control characters');

export const email = z.string().trim().toLowerCase().max(254).email('must be a valid email address');

export const finite = z.number().finite();

export const idParams = z.object({ id: objectId }).strict();
export const projectIdParams = z.object({ projectId: objectId }).strict();

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(LIMITS.MAX_PAGE_SIZE).default(LIMITS.DEFAULT_PAGE_SIZE),
});

/** Free-text search: trimmed, bounded. Callers must escape it before building a regex. */
export const searchQuery = z.string().trim().max(80).optional();

/** Allow-listed sort: `field` or `-field` where field is in the given list. */
export const sortParam = <T extends string>(fields: readonly [T, ...T[]], def: `${'' | '-'}${NoInfer<T>}`) =>
  z
    .string()
    .default(def)
    .refine((s) => (fields as readonly string[]).includes(s.replace(/^-/, '')), `sort must be one of ${fields.join(', ')} (prefix - for descending)`)
    .transform((s) => ({ field: s.replace(/^-/, '') as T, direction: s.startsWith('-') ? (-1 as const) : (1 as const) }));

/** Escape user text for safe use inside a RegExp. */
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const sinceQuery = z.coerce.number().int().min(0).max(8.64e15);
