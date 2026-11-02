import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny, ZodError } from 'zod';
import { validationError } from '../utils/error.util';

interface Schemas {
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
}

/** Turn a ZodError into `{ fieldErrors: { "a.b": "message" }, formErrors: [...] }` (first message per field). */
export function formatZodError(err: ZodError): { fieldErrors: Record<string, string>; formErrors: string[] } {
  const fieldErrors: Record<string, string> = {};
  const formErrors: string[] = [];
  for (const issue of err.issues) {
    const path = issue.path.join('.');
    const message = issue.code === 'unrecognized_keys' ? `Unknown field(s): ${issue.keys.join(', ')}` : issue.message;
    if (!path) formErrors.push(message);
    else if (!fieldErrors[path]) fieldErrors[path] = message;
  }
  return { fieldErrors, formErrors };
}

/**
 * Validate body / params / query with Zod and store the PARSED values on
 * `req.validated`. Controllers and services only ever read `req.validated`,
 * never raw `req.body` / `req.query`.
 */
export const validateRequest =
  (schemas: Schemas) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const input: unknown = part === 'body' ? (req.body ?? {}) : (req[part] ?? {});
      const result = schema.safeParse(input);
      if (!result.success) {
        const details = formatZodError(result.error);
        const first = details.formErrors[0] ?? Object.entries(details.fieldErrors)[0]?.join(': ');
        return next(validationError(first ? `Invalid ${part}: ${first}` : `Invalid ${part}.`, details));
      }
      req.validated[part] = result.data;
    }
    next();
  };
