import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { loggerConfig } from '../config/logger.config';
import { APP_NAME } from '../constants/app.constants';
import { dbMetrics } from './db-metrics.util';
import { classifyDbError } from './error.util';
import { redact } from './redact.util';

/**
 * One Winston logger for the whole app.
 *   channel=app    diagnostics
 *   channel=http   request log lines
 *   channel=db     database operations (entity, operation, service, duration, outcome)
 *   channel=mqtt   broker / pipeline events
 *   channel=audit  security-relevant events (also persisted to the audit_logs collection)
 * Every entry carries the request id and calling service from AsyncLocalStorage
 * and is passed through `redact()`.
 */

export interface LogContext {
  requestId?: string;
  userId?: string;
  service?: string;
}

export const requestContext = new AsyncLocalStorage<LogContext>();
export const getContext = (): LogContext => requestContext.getStore() ?? {};

/** Run `fn` with `service` recorded in the log context (used by services so DB logs show who called). */
export function traced<T>(service: string, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ ...getContext(), service }, fn);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const contextFormat = winston.format((info: any) => {
  const ctx = getContext();
  if (ctx.requestId && !info.requestId) info.requestId = ctx.requestId;
  if (ctx.userId && !info.userId) info.userId = ctx.userId;
  if (ctx.service && !info.service) info.service = ctx.service;
  return info;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const redactFormat = winston.format((info: any) => {
  const { level, message, timestamp, ...rest } = info as Record<string, unknown> & { level: string; message: unknown };
  const clean = redact(rest) as Record<string, unknown>;
  for (const k of Object.keys(rest)) delete (info as Record<string, unknown>)[k];
  Object.assign(info, clean, { level, message: typeof message === 'string' ? message : JSON.stringify(redact(message)), timestamp });
  return info;
});

function build(): winston.Logger {
  const cfg = loggerConfig();
  const base = [winston.format.timestamp(), contextFormat(), redactFormat()];
  const jsonFormat = winston.format.combine(...base, winston.format.json());
  const prettyFormat = winston.format.combine(
    ...base,
    winston.format.colorize(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    winston.format.printf((info: any) => {
      const { level, message, timestamp, channel, requestId, service, env: _env, app: _app, ...rest } = info as Record<string, unknown>;
      const meta = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
      const tags = [channel, service, requestId ? `req=${String(requestId).slice(0, 8)}` : ''].filter(Boolean).join(' ');
      return `${String(timestamp).slice(11, 23)} ${level} [${tags}] ${String(message)}${meta}`;
    }),
  );
  const transports: winston.transport[] = [new winston.transports.Console({ format: cfg.format === 'json' ? jsonFormat : prettyFormat })];
  if (cfg.toFile) {
    fs.mkdirSync(cfg.directory, { recursive: true });
    transports.push(
      new DailyRotateFile({ dirname: cfg.directory, filename: 'app-%DATE%.log', format: jsonFormat, ...cfg.rotation }),
      new DailyRotateFile({ dirname: cfg.directory, filename: 'error-%DATE%.log', level: 'error', format: jsonFormat, ...cfg.rotation }),
    );
  }
  return winston.createLogger({
    level: cfg.level,
    defaultMeta: { app: APP_NAME, env: cfg.environment, channel: 'app' },
    transports,
    exitOnError: false,
  });
}

let root: winston.Logger | null = null;
const getRoot = () => (root ??= build());

type Channel = 'app' | 'http' | 'db' | 'mqtt' | 'audit' | 'auth';
const children = new Map<Channel, winston.Logger>();

export function channel(name: Channel): winston.Logger {
  let c = children.get(name);
  if (!c) {
    c = getRoot().child({ channel: name });
    children.set(name, c);
  }
  return c;
}

export const logger = {
  error: (msg: string, meta?: object) => channel('app').error(msg, meta),
  warn: (msg: string, meta?: object) => channel('app').warn(msg, meta),
  info: (msg: string, meta?: object) => channel('app').info(msg, meta),
  debug: (msg: string, meta?: object) => channel('app').debug(msg, meta),
};

export const SLOW_DB_MS = 200;

/**
 * Wrap a database operation with structured logging:
 *   { entity, operation, service, requestId, durationMs, outcome, errorCode }
 * Success is logged at debug (slow ones at warn); failures at error/warn with
 * a sanitised category — never the query or the document.
 */
export async function dbOp<T>(entity: string, operation: string, fn: () => Promise<T>, meta: { id?: string; quiet?: boolean } = {}): Promise<T> {
  const started = performance.now();
  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - started);
    const docs = /Many$/.test(operation) && /^(insert|create)/.test(operation) ? (typeof result === 'number' ? result : Array.isArray(result) ? result.length : undefined) : undefined;
    dbMetrics.record(entity, operation, durationMs, true, docs);
    if (durationMs >= SLOW_DB_MS) channel('db').warn('db.op.slow', { entity, operation, id: meta.id, durationMs, outcome: 'success' });
    else if (!meta.quiet) channel('db').debug('db.op', { entity, operation, id: meta.id, durationMs, outcome: 'success' });
    return result;
  } catch (err) {
    const durationMs = Math.round(performance.now() - started);
    dbMetrics.record(entity, operation, durationMs, false);
    const errorCode = classifyDbError(err);
    const level = errorCode === 'duplicate_key' || errorCode === 'cast' || errorCode === 'validation' ? 'warn' : 'error';
    channel('db')[level]('db.op.failed', { entity, operation, id: meta.id, durationMs, outcome: 'failure', errorCode, errorName: (err as Error)?.name });
    throw err;
  }
}

export async function flushLogs(): Promise<void> {
  if (!root) return;
  await new Promise<void>((resolve) => {
    root!.on('finish', () => resolve());
    root!.end();
    setTimeout(resolve, 1000);
  });
}
