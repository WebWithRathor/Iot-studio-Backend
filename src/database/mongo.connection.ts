import mongoose from 'mongoose';
import { databaseConfig } from '../config/database.config';
import { channel } from '../utils/logger.util';
import { redactString } from '../utils/redact.util';

/**
 * MongoDB connection lifecycle. Notes:
 *   - bufferCommands=false: queries fail fast (→ 503 DATABASE_UNAVAILABLE)
 *     instead of hanging while the database is down
 *   - strictQuery=true: unknown fields in filters are dropped
 * NoSQL-injection defence is layered elsewhere: query-sanitization middleware
 * rejects `$`/dotted keys in all input, Zod schemas only admit primitives where
 * filters are built, and DAOs construct every filter from those primitives.
 * (Mongoose's global `sanitizeFilter` is deliberately NOT enabled: it would
 * also neutralise the DAOs' own intentional `$in` / `$regex` operators.)
 */
mongoose.set('strictQuery', true);
mongoose.set('bufferCommands', false);

const log = () => channel('db');
let listenersAttached = false;

function attachListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  const c = mongoose.connection;
  c.on('connected', () => log().info('mongo.connected', { host: c.host, db: c.name }));
  c.on('disconnected', () => log().warn('mongo.disconnected — requests needing the database will return 503 until it reconnects'));
  c.on('reconnected', () => log().info('mongo.reconnected'));
  c.on('error', (err: Error) => log().error('mongo.error', { errorName: err.name, error: redactString(err.message) }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function connectMongo(): Promise<void> {
  const cfg = databaseConfig();
  attachListeners();
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      log().info('mongo.connecting', { attempt, uri: redactString(cfg.uri) });
      await mongoose.connect(cfg.uri, cfg.options);
      return;
    } catch (err) {
      const e = err as Error;
      log().error('mongo.connect.failed', { attempt, errorName: e.name, error: redactString(e.message) });
      if (attempt >= cfg.connectRetries) {
        throw new Error(`Could not connect to MongoDB after ${attempt} attempts. Is it running? (see README → "Start the dependencies")`);
      }
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 10_000));
    }
  }
}

export const isMongoReady = (): boolean => mongoose.connection.readyState === 1;

export async function pingMongo(): Promise<boolean> {
  try {
    if (!isMongoReady() || !mongoose.connection.db) return false;
    await mongoose.connection.db.admin().command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function disconnectMongo(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  log().info('mongo.closed');
}
