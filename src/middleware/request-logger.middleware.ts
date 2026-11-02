import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { channel, requestContext } from '../utils/logger.util';

const INCOMING_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Assigns the correlation id (accepts a well-formed incoming X-Request-Id),
 * opens the async logging context for the request and writes one access log
 * line on completion. Query strings are NOT logged (they may contain
 * search terms); only the route path.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get('x-request-id');
  req.requestId = incoming && INCOMING_ID.test(incoming) ? incoming : randomUUID();
  req.validated = {};
  res.setHeader('X-Request-Id', req.requestId);
  const started = process.hrtime.bigint();
  requestContext.run({ requestId: req.requestId }, () => {
    res.on('finish', () => {
      const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
      const status = res.statusCode;
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'http';
      // The SSE stream stays open for minutes; its close is logged by the realtime service.
      channel('http')[level]('request', {
        requestId: req.requestId,
        method: req.method,
        path: req.baseUrl + (req.route?.path ?? req.path),
        status,
        durationMs,
        userId: req.user?.id,
        bytes: Number(res.getHeader('content-length') ?? 0) || undefined,
      });
    });
    next();
  });
}
