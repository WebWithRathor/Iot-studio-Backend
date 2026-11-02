import mongoose, { type ClientSession } from 'mongoose';
import { databaseConfig } from '../config/database.config';
import { channel } from '../utils/logger.util';

/**
 * Multi-document transactions need a replica set (or sharded cluster).
 * A standalone mongod does NOT support them, so this module detects support
 * at startup and is explicit about what happens:
 *   MONGODB_TRANSACTIONS=on    → refuse to start without a replica set
 *   MONGODB_TRANSACTIONS=off   → never use transactions
 *   MONGODB_TRANSACTIONS=auto  → use them when available, otherwise run the
 *                                steps sequentially (NOT atomic) and log it
 * The bundled docker-compose runs a single-node replica set, so local
 * development gets real transactions.
 */
let supported = false;
let warned = false;

export async function detectTransactionSupport(): Promise<boolean> {
  const mode = databaseConfig().transactions;
  if (mode === 'off') {
    supported = false;
    return false;
  }
  try {
    const hello = (await mongoose.connection.db!.admin().command({ hello: 1 })) as { setName?: string; msg?: string };
    supported = Boolean(hello.setName) || hello.msg === 'isdbgrid';
  } catch {
    supported = false;
  }
  if (mode === 'on' && !supported) {
    throw new Error('MONGODB_TRANSACTIONS=on but MongoDB is not a replica set. Use the docker-compose MongoDB or set MONGODB_TRANSACTIONS=auto.');
  }
  channel('db').info('mongo.transactions', { supported, mode });
  return supported;
}

export const transactionsSupported = () => supported;

/**
 * Run `fn` atomically when transactions are available. `fn` receives the
 * session (or undefined) and must pass it to every DAO call.
 */
export async function withTransaction<T>(label: string, fn: (session?: ClientSession) => Promise<T>): Promise<T> {
  if (!supported) {
    if (!warned) {
      warned = true;
      channel('db').warn('mongo.transactions.unavailable — multi-step writes run sequentially without atomicity', { label });
    }
    return fn(undefined);
  }
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
