/**
 * Deterministic test environment. Import FIRST in any test that touches
 * code calling loadEnv(). Values are test-only. Integration tests read
 * TEST_MONGODB_URI / TEST_REDIS_URL so they never touch your dev database.
 */
import { randomBytes } from 'node:crypto';

const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '4999',
  FRONTEND_URL: 'http://localhost:5173',
  API_BASE_PATH: '/api/v1',
  MONGODB_URI: process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/kokoon_test?replicaSet=rs0&directConnection=true',
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://:kokoon-dev-redis@127.0.0.1:6379/15',
  REDIS_KEY_PREFIX: 'kokoon-test:',
  JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'),
  JWT_REFRESH_SECRET: randomBytes(48).toString('base64url'),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  MQTT_MODE: 'simulated',
  // Pinned so a developer .env (e.g. mosquitto-dynsec, which needs MQTT_MODE=broker) can't leak
  // in through dotenv and make loadEnv() reject the test settings. LMS tests set their own first.
  BROKER_CREDENTIALS_MODE: 'shared',
  LMS_INTEGRATION_ENABLED: 'false',
  DEMO_SIMULATION: 'false',
  DEMO_WORKSPACE_ON_SIGNUP: 'false',
  LOG_LEVEL: 'error',
  LOG_TO_FILE: 'false',
  AUTH_RATE_LIMIT_MAX_REQUESTS: '1000',
  RATE_LIMIT_MAX_REQUESTS: '100000',
};
for (const [k, v] of Object.entries(defaults)) if (!process.env[k]) process.env[k] = v;
export {};
