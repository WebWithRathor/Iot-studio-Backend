import Redis from 'ioredis';
import { redisConfig, redisKeys } from '../../config/redis.config';
import { ERROR_CODES } from '../../constants/error-codes.constants';
import { serviceUnavailable } from '../../utils/error.util';
import { LatestCoalescer } from '../../utils/ingest-buffer.util';
import { channel } from '../../utils/logger.util';
import { redactString } from '../../utils/redact.util';

/**
 * Redis holds SHORT-LIVED server state only:
 *   session:{sid}        live refresh-session state (rotation + revocation), TTL = refresh lifetime
 *   user-auth:{id}       cached {role,status,tokenVersion}, TTL 60 s
 *   latest:{deviceId}    hash topic → latest value, TTL 7 d (refreshed on every write;
 *                        writes are coalesced in memory and sent as one pipeline per 250 ms)
 *   cmd:{topic}          pending command awaiting ack, TTL 30 s
 *   rl:*                 rate-limit counters
 *   lms:sso-jti:{jti}    used LMS SSO token ids (single use), TTL 120 s
 *   lms:idem:{id}        LMS API idempotency records (encrypted response), TTL 24 h
 * Durable data lives in MongoDB. When Redis is down, authentication fails
 * closed with 503 — session revocation is never bypassed.
 */

let client: Redis | null = null;
let ready = false;
const log = () => channel('app');

const LATEST_TTL_S = 7 * 86400;
const LATEST_FLUSH_MS = 250;
let latestTimer: NodeJS.Timeout | null = null;
let latestErrorLoggedAt = 0;

/** One pipeline per tick: HSET every dirty topic of a device, then EXPIRE that device's hash (same TTL semantics as before). */
async function writeLatest(dirty: Map<string, Map<string, string>>): Promise<void> {
  const pipe = c().pipeline();
  for (const [deviceId, fields] of dirty) {
    const key = redisKeys.latest(deviceId);
    pipe.hset(key, Object.fromEntries(fields)).expire(key, LATEST_TTL_S);
  }
  const res = (await pipe.exec()) ?? [];
  const failed = res.find(([err]) => err);
  if (failed) throw failed[0];
}

const latest = new LatestCoalescer({
  write: writeLatest,
  maxEntries: 200_000,
  onError: (err) => {
    const now = Date.now();
    if (now - latestErrorLoggedAt < 30_000) return;
    latestErrorLoggedAt = now;
    log().warn('redis.latest.write_failed — values kept for the next tick', { errorName: (err as Error).name, pending: latest.size });
  },
});

function ensureLatestTimer(): void {
  if (latestTimer) return;
  latestTimer = setInterval(() => void latest.flush(), LATEST_FLUSH_MS);
  latestTimer.unref();
}

export interface SessionState {
  userId: string;
  jtiHash: string;
  prevJtiHash?: string;
  rotatedAt?: number;
}

export interface UserAuthState {
  role: string;
  status: string;
  tokenVersion: number;
  email: string;
  name: string;
}

/** Compare-and-rotate. 1 = rotated, 2 = presented token was just rotated (grace), 0 = mismatch / missing. */
const ROTATE_LUA = `
local cur = redis.call('HGET', KEYS[1], 'jtiHash')
if not cur then return 0 end
if cur == ARGV[1] then
  redis.call('HSET', KEYS[1], 'prevJtiHash', cur, 'jtiHash', ARGV[2], 'rotatedAt', ARGV[3])
  return 1
end
local prev = redis.call('HGET', KEYS[1], 'prevJtiHash')
local at = tonumber(redis.call('HGET', KEYS[1], 'rotatedAt') or '0')
if prev == ARGV[1] and (tonumber(ARGV[3]) - at) <= tonumber(ARGV[4]) then return 2 end
return 0
`;

function c(): Redis {
  if (!client || !ready) throw serviceUnavailable(ERROR_CODES.CACHE_UNAVAILABLE, 'The session store is unavailable. Try again shortly.');
  return client;
}

export const redisService = {
  async connect(): Promise<void> {
    const cfg = redisConfig();
    client = new Redis(cfg.url, { ...cfg.options, keyPrefix: cfg.keyPrefix });
    client.on('ready', () => {
      ready = true;
      log().info('redis.ready');
    });
    client.on('end', () => {
      ready = false;
      log().warn('redis.closed');
    });
    client.on('reconnecting', () => log().warn('redis.reconnecting'));
    client.on('error', (err: Error) => {
      ready = false;
      log().error('redis.error', { errorName: err.name, error: redactString(err.message) });
    });
    try {
      await client.connect();
      ready = true;
    } catch (err) {
      throw new Error(`Could not connect to Redis (${redactString((err as Error).message)}). Is it running? (see README → "Start the dependencies")`);
    }
  },

  raw(): Redis {
    return c();
  },

  isReady: () => ready,

  async ping(): Promise<boolean> {
    try {
      return (await c().ping()) === 'PONG';
    } catch {
      return false;
    }
  },

  async close(): Promise<void> {
    if (latestTimer) clearInterval(latestTimer);
    latestTimer = null;
    if (ready) await latest.flushNow().catch(() => undefined);
    if (!client) return;
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
    client = null;
    ready = false;
  },

  /* -------------------------------------------------------- sessions */

  async putSession(sid: string, s: SessionState, ttlSec: number): Promise<void> {
    const key = redisKeys.session(sid);
    await c().multi().hset(key, { userId: s.userId, jtiHash: s.jtiHash, rotatedAt: String(Date.now()) }).expire(key, ttlSec).exec();
  },

  async getSession(sid: string): Promise<SessionState | null> {
    const h = await c().hgetall(redisKeys.session(sid));
    if (!h || !h.userId) return null;
    return { userId: h.userId, jtiHash: h.jtiHash, prevJtiHash: h.prevJtiHash, rotatedAt: Number(h.rotatedAt ?? 0) };
  },

  async sessionExists(sid: string): Promise<boolean> {
    return (await c().exists(redisKeys.session(sid))) === 1;
  },

  async rotateSession(sid: string, presentedHash: string, newHash: string, graceMs: number): Promise<0 | 1 | 2> {
    // ioredis applies keyPrefix to EVAL's KEYS (numkeys = 1), so pass the unprefixed key.
    const r = (await c().eval(ROTATE_LUA, 1, redisKeys.session(sid), presentedHash, newHash, String(Date.now()), String(graceMs))) as number;
    return (r === 1 || r === 2 ? r : 0) as 0 | 1 | 2;
  },

  async deleteSessions(sids: string[]): Promise<void> {
    if (sids.length) await c().del(...sids.map(redisKeys.session));
  },

  /* ------------------------------------------------- user auth cache */

  async getUserAuth(userId: string): Promise<UserAuthState | null> {
    const v = await c().get(redisKeys.userAuth(userId));
    return v ? (JSON.parse(v) as UserAuthState) : null;
  },

  async setUserAuth(userId: string, s: UserAuthState): Promise<void> {
    await c().set(redisKeys.userAuth(userId), JSON.stringify(s), 'EX', 60);
  },

  async dropUserAuth(userId: string): Promise<void> {
    await c().del(redisKeys.userAuth(userId));
  },

  /* ---------------------------------------------------- latest values */

  /** Queue a latest value; written with the next 250 ms pipeline (newest value per topic wins). Never throws. */
  queueLatest(deviceId: string, topic: string, value: unknown, at: number): void {
    latest.set(deviceId, topic, JSON.stringify({ value, at }));
    ensureLatestTimer();
  },

  latestStats: () => ({ pending: latest.size, ...latest.stats }),

  async getLatest(deviceIds: string[]): Promise<Record<string, { value: unknown; at: number }>> {
    if (!deviceIds.length) return {};
    const pipe = c().pipeline();
    deviceIds.forEach((id) => pipe.hgetall(redisKeys.latest(id)));
    const res = (await pipe.exec()) ?? [];
    const out: Record<string, { value: unknown; at: number }> = {};
    for (const [err, h] of res) {
      if (err || !h) continue;
      for (const [topic, json] of Object.entries(h as Record<string, string>)) {
        try {
          out[topic] = JSON.parse(json) as { value: unknown; at: number };
        } catch {
          /* ignore corrupt entry */
        }
      }
    }
    return out;
  },

  async dropLatest(deviceIds: string[]): Promise<void> {
    latest.discard(deviceIds);
    await latest.flushNow(); // a write already in flight must land BEFORE the delete, not after it
    if (deviceIds.length) await c().del(...deviceIds.map(redisKeys.latest));
  },

  /* ---------------------------------------------------- LMS integration */

  /** Mark an SSO token id as used. True the first time, false on every replay. */
  async claimSsoJti(jti: string, ttlSec: number): Promise<boolean> {
    return (await c().set(redisKeys.lmsSsoJti(jti), '1', 'EX', ttlSec, 'NX')) === 'OK';
  },

  /** Reserve an idempotency key. Returns null when reserved now, else the existing record. */
  async reserveIdempotency(requestId: string, record: string, ttlSec: number): Promise<string | null> {
    const key = redisKeys.lmsIdempotency(requestId);
    if ((await c().set(key, record, 'EX', ttlSec, 'NX')) === 'OK') return null;
    return (await c().get(key)) ?? '';
  },

  async storeIdempotency(requestId: string, record: string, ttlSec: number): Promise<void> {
    await c().set(redisKeys.lmsIdempotency(requestId), record, 'EX', ttlSec);
  },

  async releaseIdempotency(requestId: string): Promise<void> {
    await c().del(redisKeys.lmsIdempotency(requestId));
  },

  /* ------------------------------------------------- pending commands */

  async setPending(topic: string, data: { messageId: string; ownerId: string; at: number }, ttlSec: number): Promise<void> {
    await c().set(redisKeys.pendingCommand(topic), JSON.stringify(data), 'EX', ttlSec);
  },

  async takePending(topic: string): Promise<{ messageId: string; ownerId: string; at: number } | null> {
    const key = redisKeys.pendingCommand(topic);
    const v = (await c().multi().get(key).del(key).exec())?.[0]?.[1] as string | null | undefined;
    return v ? (JSON.parse(v) as { messageId: string; ownerId: string; at: number }) : null;
  },
};
