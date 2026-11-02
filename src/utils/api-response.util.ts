import type { Request, Response } from 'express';
import type { ApiFailure, ApiSuccess } from '../types/common.types';

/** `{ success, data, message?, requestId }` — the single success shape. */
export function sendSuccess<T>(req: Request, res: Response, data: T, opts: { status?: number; message?: string } = {}): void {
  const body: ApiSuccess<T> = { success: true, data, requestId: req.requestId };
  if (opts.message) body.message = opts.message;
  res.status(opts.status ?? 200).json(body);
}

export const sendCreated = <T>(req: Request, res: Response, data: T, message?: string) => sendSuccess(req, res, data, { status: 201, message });

export function buildFailure(requestId: string, code: string, message: string, details?: unknown): ApiFailure {
  const body: ApiFailure = { success: false, error: { code, message }, requestId };
  if (details !== undefined) body.error.details = details;
  return body;
}
