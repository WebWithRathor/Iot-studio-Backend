import { z } from 'zod';
import { parseDuration } from '../utils/date.util';

/**
 * Environment validation. Runs before anything else in server.ts, so the
 * process refuses to start (and never accepts a request) with a missing or
 * malformed configuration. Error output lists variable NAMES and problems,
 * never values.
 */

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1' || v === 'yes');

const int = (def: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(def);

const duration = (def: string, minSec: number, maxSec: number) =>
  z
    .string()
    .default(def)
    .transform((v, ctx) => {
      const s = parseDuration(v);
      if (s === null || s < minSec || s > maxSec) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be a duration like 10m or 7d between ${minSec}s and ${maxSec}s` });
        return z.NEVER;
      }
      return s;
    });

const DEV_PLACEHOLDER = /change[-_ ]?me|replace[-_ ]?with|dev[-_]?only|example|placeholder|secret123/i;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: int(4000, 1, 65535),
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),
    /** Extra allowed browser origins, comma separated. */
    CORS_ORIGINS: z.string().default(''),
    API_BASE_PATH: z
      .string()
      .regex(/^\/[a-z0-9/_-]*[a-z0-9]$/i, 'must look like /api/v1')
      .default('/api/v1'),
    TRUST_PROXY: int(0, 0, 10),

    MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb:// or mongodb+srv:// URI'),
    MONGODB_TRANSACTIONS: z.enum(['auto', 'on', 'off']).default('auto'),
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: int(5000, 500, 60000),

    REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// URL'),
    REDIS_KEY_PREFIX: z.string().regex(/^[a-z0-9:_-]{1,32}$/i).default('kokoon:'),

    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ISSUER: z.string().min(1).default('kokoon-iot-studio'),
    JWT_AUDIENCE: z.string().min(1).default('kokoon-iot-studio-web'),
    ACCESS_TOKEN_TTL: duration('10m', 60, 3600),
    REFRESH_TOKEN_TTL: duration('7d', 3600, 60 * 86400),

    COOKIE_SECURE: bool(false),
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    COOKIE_DOMAIN: z.string().optional().transform((v) => (v ? v : undefined)),

    /** base64-encoded 32-byte key for AES-256-GCM (session metadata at rest). */
    ENCRYPTION_KEY: z
      .string()
      .refine((v) => {
        try {
          return Buffer.from(v, 'base64').length === 32;
        } catch {
          return false;
        }
      }, 'must be 32 random bytes, base64 encoded'),

    MQTT_MODE: z.enum(['simulated', 'broker']).default('simulated'),
    MQTT_BROKER_URL: z.string().regex(/^(mqtts?|wss?):\/\//, 'must be mqtt://, mqtts://, ws:// or wss://').optional(),
    MQTT_USERNAME: z.string().optional(),
    MQTT_PASSWORD: z.string().optional(),
    MQTT_CLIENT_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default('kokoon-backend'),
    MQTT_TOPIC_ROOT: z.string().regex(/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/i).default('kokoon/devices'),
    DEMO_SIMULATION: bool(true),
    SIM_INTERVAL_MS: int(2000, 500, 60000),
    MESSAGE_RETENTION_HOURS: int(24, 1, 24 * 90),
    PERSIST_TELEMETRY: bool(true),
    /** Persist at most one telemetry document per topic per interval (newest value wins); 0 = every message. Live values are never sampled. */
    TELEMETRY_PERSIST_INTERVAL_MS: int(5000, 0, 3_600_000),

    /** Token allowance per plan (see constants/plans.constants.ts). */
    FREE_PLAN_TOKENS: int(1000, 0, 10_000_000),
    PLUS_PLAN_TOKENS: int(10_000, 0, 10_000_000),
    PREMIUM_PLAN_TOKENS: int(50_000, 0, 10_000_000),

    /** Payments. `mock` = built-in test checkout (development only); `razorpay` = real gateway. */
    PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
    /** Price of the Plus pack (10,000 tokens) in whole rupees. */
    PLUS_PACK_PRICE_INR: int(999, 1, 10_000_000),
    RAZORPAY_KEY_ID: z.string().regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, 'must look like rzp_test_… or rzp_live_…').optional(),
    RAZORPAY_KEY_SECRET: z.string().min(8).optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().min(8).optional(),

    REGISTRATION_ENABLED: bool(true),
    /** The token budget (plans, kit codes, costs). Off until the admin switches it on in the admin panel. */
    TOKENS_ENABLED: bool(false),
    DEMO_WORKSPACE_ON_SIGNUP: bool(true),

    /** Kokoon LMS integration (SSO + server-to-server device API). See docs/LMS-INTEGRATION.md. */
    LMS_INTEGRATION_ENABLED: bool(false),
    LMS_URL: z.string().url().optional(),
    /** HS256 key for SSO tokens minted by the LMS. Shared with the LMS backend only. */
    LMS_SSO_SECRET: z.string().min(48, 'must be at least 48 characters').optional(),
    /** HMAC-SHA256 key for the LMS → IoT Studio API. Shared with the LMS backend only. */
    LMS_API_SECRET: z.string().min(48, 'must be at least 48 characters').optional(),
    /** Broker address handed to devices (it is usually NOT the address the backend itself uses). */
    MQTT_PUBLIC_BROKER_URL: z.string().regex(/^(mqtts?|wss?):\/\//, 'must be mqtt://, mqtts://, ws:// or wss://').optional(),
    /** How device broker accounts are issued: one shared dev account, or one per device via Mosquitto dynamic security. */
    BROKER_CREDENTIALS_MODE: z.enum(['shared', 'mosquitto-dynsec']).default('shared'),
    MQTT_DEVICE_USERNAME: z.string().optional(),
    MQTT_DEVICE_PASSWORD: z.string().optional(),
    /** Signed LMS → IoT Studio calls per minute, counted after the signature check (one bucket for the LMS). */
    LMS_API_RATE_LIMIT_PER_MIN: int(6000, 60, 1_000_000),

    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
    LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),
    LOG_TO_FILE: bool(true),
    LOG_DIRECTORY: z.string().default('logs'),
    LOG_DB_OPERATIONS: bool(true),

    RATE_LIMIT_WINDOW_MS: int(60_000, 1000, 3_600_000),
    RATE_LIMIT_MAX_REQUESTS: int(600, 10, 100_000),
    AUTH_RATE_LIMIT_MAX_REQUESTS: int(10, 1, 1000),
    COMMAND_RATE_LIMIT_PER_10S: int(20, 1, 1000),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) issue('JWT_REFRESH_SECRET', 'must differ from JWT_ACCESS_SECRET');
    if (env.MQTT_MODE === 'broker' && !env.MQTT_BROKER_URL) issue('MQTT_BROKER_URL', 'is required when MQTT_MODE=broker');
    if (env.COOKIE_SAME_SITE === 'none' && !env.COOKIE_SECURE) issue('COOKIE_SAME_SITE', 'SameSite=None requires COOKIE_SECURE=true');
    if (env.PAYMENT_PROVIDER === 'razorpay') {
      if (!env.RAZORPAY_KEY_ID) issue('RAZORPAY_KEY_ID', 'is required when PAYMENT_PROVIDER=razorpay');
      if (!env.RAZORPAY_KEY_SECRET) issue('RAZORPAY_KEY_SECRET', 'is required when PAYMENT_PROVIDER=razorpay');
    }
    if (env.LMS_INTEGRATION_ENABLED) {
      if (!env.LMS_URL) issue('LMS_URL', 'is required when LMS_INTEGRATION_ENABLED=true');
      if (!env.LMS_SSO_SECRET) issue('LMS_SSO_SECRET', 'is required when LMS_INTEGRATION_ENABLED=true');
      if (!env.LMS_API_SECRET) issue('LMS_API_SECRET', 'is required when LMS_INTEGRATION_ENABLED=true');
      if (env.LMS_SSO_SECRET && env.LMS_SSO_SECRET === env.LMS_API_SECRET) issue('LMS_API_SECRET', 'must differ from LMS_SSO_SECRET');
      for (const k of ['LMS_SSO_SECRET', 'LMS_API_SECRET'] as const) {
        if (env[k] && (env[k] === env.JWT_ACCESS_SECRET || env[k] === env.JWT_REFRESH_SECRET)) issue(k, 'must differ from the JWT secrets');
      }
      if (!env.MQTT_PUBLIC_BROKER_URL) issue('MQTT_PUBLIC_BROKER_URL', 'is required when LMS_INTEGRATION_ENABLED=true (the address devices connect to)');
      if (env.BROKER_CREDENTIALS_MODE === 'shared' && (!env.MQTT_DEVICE_USERNAME || !env.MQTT_DEVICE_PASSWORD)) {
        issue('MQTT_DEVICE_USERNAME', 'MQTT_DEVICE_USERNAME and MQTT_DEVICE_PASSWORD are required when BROKER_CREDENTIALS_MODE=shared');
      }
    }
    if (env.BROKER_CREDENTIALS_MODE === 'mosquitto-dynsec' && env.MQTT_MODE !== 'broker') issue('BROKER_CREDENTIALS_MODE', 'mosquitto-dynsec requires MQTT_MODE=broker');
    if (env.NODE_ENV === 'production') {
      if (!env.COOKIE_SECURE) issue('COOKIE_SECURE', 'must be true in production');
      if (env.LMS_INTEGRATION_ENABLED) {
        if (env.LMS_URL && !env.LMS_URL.startsWith('https://')) issue('LMS_URL', 'must be https in production');
        if (env.MQTT_PUBLIC_BROKER_URL && !/^(mqtts|wss):/.test(env.MQTT_PUBLIC_BROKER_URL)) issue('MQTT_PUBLIC_BROKER_URL', 'must use TLS (mqtts:// or wss://) in production');
        if (env.BROKER_CREDENTIALS_MODE !== 'mosquitto-dynsec') issue('BROKER_CREDENTIALS_MODE', 'must be mosquitto-dynsec in production (one broker account per device)');
        for (const k of ['LMS_SSO_SECRET', 'LMS_API_SECRET'] as const) {
          if (env[k] && DEV_PLACEHOLDER.test(env[k])) issue(k, 'must be a unique random secret in production');
        }
      }
      for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
        if (env[k].length < 48 || DEV_PLACEHOLDER.test(env[k])) issue(k, 'must be a unique random secret of 48+ characters in production');
      }
      if (new Set(Buffer.from(env.ENCRYPTION_KEY, 'base64')).size < 16) issue('ENCRYPTION_KEY', 'must be a real random key in production');
      if (!env.FRONTEND_URL.startsWith('https://')) issue('FRONTEND_URL', 'must be https in production');
      if (env.MQTT_MODE === 'broker' && env.MQTT_BROKER_URL && !/^(mqtts|wss):/.test(env.MQTT_BROKER_URL)) issue('MQTT_BROKER_URL', 'must use TLS (mqtts:// or wss://) in production');
      if (env.DEMO_WORKSPACE_ON_SIGNUP) issue('DEMO_WORKSPACE_ON_SIGNUP', 'must be false in production');
      if (env.PAYMENT_PROVIDER === 'mock') issue('PAYMENT_PROVIDER', 'the mock test checkout cannot run in production — use razorpay');
      if (env.PAYMENT_PROVIDER === 'razorpay' && !env.RAZORPAY_WEBHOOK_SECRET) issue('RAZORPAY_WEBHOOK_SECRET', 'is required in production (payments must be confirmed by webhook too)');
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/** Pure: validate a raw env object. Never echoes values. */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (v !== undefined && v !== '') cleaned[k] = v;
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.code === 'invalid_type' && i.received === 'undefined' ? 'is required' : i.message}`);
    throw new EnvValidationError(problems);
  }
  return result.data;
}

let cached: Env | null = null;

/** Load `.env` (if present) and validate. Memoised. */
export function loadEnv(): Env {
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('dotenv').config({ quiet: true });
  } catch {
    /* dotenv is optional when variables come from the process environment */
  }
  cached = parseEnv(process.env);
  return cached;
}

/** Validated configuration. Importing this triggers validation. */
export const env: Env = new Proxy({} as Env, {
  get(_t, prop: string) {
    return loadEnv()[prop as keyof Env];
  },
});

export const isProduction = () => loadEnv().NODE_ENV === 'production';
export const isTest = () => loadEnv().NODE_ENV === 'test';

/** Allowed browser origins for CORS and the CSRF origin check. */
export function allowedOrigins(): string[] {
  const e = loadEnv();
  const extra = e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set([new URL(e.FRONTEND_URL).origin, ...extra.map((o) => new URL(o).origin)]));
}
