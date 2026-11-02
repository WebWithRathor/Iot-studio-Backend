import type { Request, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { isReservedHardwareId, lmsConfig } from '../../config/lms.config';
import { lmsState, sendLms } from '../../middleware/lms-api.middleware';
import { formatZodError } from '../../middleware/validate-request.middleware';
import { lmsIntegrationService } from '../../services/integrations/lms-integration.service';
import { asyncHandler } from '../../utils/async-handler.util';
import { LmsApiError } from '../../utils/lms-api-error.util';
import { lmsBulkStatusBody, lmsHardwareId, lmsUpsertDeviceBody, lmsUpsertQuery } from '../../validations/integrations/lms.validation';

/**
 * LMS → IoT Studio API (contract B). Runs after the signature and idempotency
 * middleware; the body is the RAW buffer that was signed, parsed here.
 * Success bodies are the contract's plain JSON (no `{ success, data }` envelope).
 */

function parse<S extends ZodTypeAny>(schema: S, value: unknown, part: string): z.infer<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const details = formatZodError(r.error);
  const first = details.formErrors[0] ?? Object.entries(details.fieldErrors)[0]?.join(': ');
  throw new LmsApiError(422, 'validation_failed', first ? `Invalid ${part}: ${first}` : `Invalid ${part}.`, details);
}

function jsonBody(req: Request, res: Response): unknown {
  if (!/^application\/json\b/i.test(req.get('content-type') ?? '')) throw new LmsApiError(422, 'validation_failed', 'Content-Type must be application/json.');
  const raw = lmsState(res).rawBody;
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new LmsApiError(422, 'validation_failed', 'The request body is not valid JSON.');
  }
}

/** The :hardwareId path segment: format, reserved prefixes, and never one of the backend's own broker identities. */
function hardwareIdParam(req: Request): string {
  const hardwareId = parse(lmsHardwareId, req.params.hardwareId, 'hardwareId');
  if (isReservedHardwareId(hardwareId, lmsConfig().reservedAccounts)) {
    throw new LmsApiError(422, 'validation_failed', 'Invalid hardwareId: this hardware id is reserved.', { fieldErrors: {}, formErrors: ['this hardware id is reserved'] });
  }
  return hardwareId;
}

export const lmsController = {
  /** B1 — PUT /integrations/lms/devices/:hardwareId[?rotateCredentials=true][&replaceChip=true] */
  upsertDevice: asyncHandler(async (req: Request, res: Response) => {
    const hardwareId = hardwareIdParam(req);
    const query = parse(lmsUpsertQuery, req.query, 'query');
    const body = parse(lmsUpsertDeviceBody, jsonBody(req, res), 'body');
    const { created, body: out } = await lmsIntegrationService.upsertDevice(hardwareId, body, {
      rotateCredentials: query.rotateCredentials ?? false,
      replaceChip: query.replaceChip ?? false,
      ip: req.ip,
    });
    res.set('Cache-Control', 'no-store'); // may contain device credentials
    await sendLms(res, created ? 201 : 200, out);
  }),

  /** B2 — GET /integrations/lms/devices/:hardwareId */
  getDevice: asyncHandler(async (req: Request, res: Response) => {
    const hardwareId = hardwareIdParam(req);
    await sendLms(res, 200, await lmsIntegrationService.getDevice(hardwareId));
  }),

  /** Bulk B2 — POST /integrations/lms/devices/status {"hardwareIds":[…1..200]} (read-only, not idempotency-stored) */
  devicesStatus: asyncHandler(async (req: Request, res: Response) => {
    const body = parse(lmsBulkStatusBody, jsonBody(req, res), 'body');
    await sendLms(res, 200, await lmsIntegrationService.devicesStatus(body.hardwareIds));
  }),

  /** B3 — DELETE /integrations/lms/devices/:hardwareId */
  disableDevice: asyncHandler(async (req: Request, res: Response) => {
    const hardwareId = hardwareIdParam(req);
    await lmsIntegrationService.disableDevice(hardwareId, req.ip);
    await sendLms(res, 204);
  }),
};
