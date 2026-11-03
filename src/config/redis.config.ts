import { loadEnv } from './env.config';

export function redisConfig() {
  const e = loadEnv();
  return {
    url: e.REDIS_URL,
    keyPrefix: e.REDIS_KEY_PREFIX,
    options: {
      lazyConnect: true,
      enableOfflineQueue: false, // fail fast instead of queueing while Redis is down
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
    },
  };
}

/** Key builders — every Redis key the app uses is defined here. */
export const redisKeys = {
  session: (sid: string) => `session:${sid}`,
  userAuth: (userId: string) => `user-auth:${userId}`,
  latest: (deviceId: string) => `latest:${deviceId}`,
  pendingCommand: (topic: string) => `cmd:${topic}`,
  rateLimit: (name: string) => `rl:${name}:`,
  simState: () => 'sim:state',
  appSettings: () => 'app:settings',
  lmsSsoJti: (jti: string) => `lms:sso-jti:${jti}`,
  lmsIdempotency: (requestId: string) => `lms:idem:${requestId}`,
};
