import type { NextFunction, Request, Response } from 'express';
import { LIMITS } from '../constants/app.constants';
import { unsafeInput } from '../utils/error.util';

/**
 * First line of defence against NoSQL operator injection and prototype
 * pollution, applied to EVERY request before validation:
 *   - rejects keys starting with `$` (MongoDB operators) or containing `.`
 *     (dotted paths) anywhere in body, query or params
 *   - rejects __proto__ / constructor / prototype keys
 *   - rejects nested objects in the query string (only strings / string arrays)
 *   - limits depth, keys per object and array length
 * It REJECTS (400 UNSAFE_INPUT) rather than silently stripping, so a malformed
 * request is visible. It is not a substitute for Zod validation, ownership
 * checks or DAO filter construction — all three still apply.
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function findUnsafe(value: unknown, depth = 0, path = ''): string | null {
  if (value === null || typeof value !== 'object') return null;
  if (depth > LIMITS.MAX_SANITIZE_DEPTH) return `${path || 'input'} is nested too deeply`;
  if (Array.isArray(value)) {
    if (value.length > LIMITS.MAX_ARRAY_LENGTH) return `${path || 'input'} has too many items`;
    for (let i = 0; i < value.length; i++) {
      const p = findUnsafe(value[i], depth + 1, `${path}[${i}]`);
      if (p) return p;
    }
    return null;
  }
  const keys = Object.keys(value as object);
  if (keys.length > LIMITS.MAX_OBJECT_KEYS) return `${path || 'input'} has too many fields`;
  for (const k of keys) {
    if (k.startsWith('$')) return `field names may not start with “$” (${path ? `${path}.` : ''}${k})`;
    if (k.includes('.')) return `field names may not contain “.” (${path ? `${path}.` : ''}${k})`;
    if (FORBIDDEN_KEYS.has(k)) return `field name “${k}” is not allowed`;
    const p = findUnsafe((value as Record<string, unknown>)[k], depth + 1, path ? `${path}.${k}` : k);
    if (p) return p;
  }
  // Own __proto__ set via JSON.parse is caught above; also catch non-plain prototypes.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return `${path || 'input'} has an unexpected type`;
  return null;
}

export function findUnsafeQuery(query: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(query)) {
    if (typeof v === 'string') continue;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length <= 50) continue;
    return `query parameter “${k}” must be a plain value`;
  }
  return findUnsafe(query);
}

export function querySanitization(req: Request, _res: Response, next: NextFunction): void {
  const problem = findUnsafeQuery((req.query ?? {}) as Record<string, unknown>) ?? findUnsafe(req.params) ?? findUnsafe(req.body);
  if (problem) return next(unsafeInput(`Request rejected: ${problem}.`));
  next();
}
