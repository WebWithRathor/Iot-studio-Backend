import { loadEnv } from './env.config';

/**
 * Kokoon LMS integration settings (contract: docs/LMS-INTEGRATION.md).
 * The two shared secrets never leave the server: they are not sent to the
 * browser, not logged, and not embedded in device firmware.
 */

export interface PublicBroker {
  url: string;
  host: string;
  port: number;
  tls: boolean;
}

const DEFAULT_PORTS: Record<string, number> = { 'mqtt:': 1883, 'mqtts:': 8883, 'ws:': 80, 'wss:': 443 };

/** Pure: `mqtt://192.168.1.20:1883` → { url, host, port, tls }. */
export function parseBrokerUrl(url: string): PublicBroker {
  const u = new URL(url);
  const port = u.port ? Number(u.port) : DEFAULT_PORTS[u.protocol] ?? 1883;
  return { url, host: u.hostname, port, tls: u.protocol === 'mqtts:' || u.protocol === 'wss:' };
}

/**
 * Hardware ids that can never become a device: they would collide with a
 * broker account or client id of the backend (dynsec username = clientId =
 * hardwareId), the admin naming, or the simulator.
 */
export const RESERVED_HARDWARE_ID_PREFIXES = ['kokoon-backend', 'admin', 'sandbox-', 'esp32-sim-'] as const;

/** Pure: true if `hardwareId` is reserved. `accounts` = broker usernames / client ids in use by the backend. */
export function isReservedHardwareId(hardwareId: string, accounts: readonly (string | null | undefined)[] = []): boolean {
  if (RESERVED_HARDWARE_ID_PREFIXES.some((p) => hardwareId.startsWith(p))) return true;
  return accounts.some((a) => !!a && (hardwareId === a || hardwareId.startsWith(`${a}-`)));
}

export function lmsConfig() {
  const e = loadEnv();
  return {
    enabled: e.LMS_INTEGRATION_ENABLED,
    url: e.LMS_URL ?? null,
    origin: e.LMS_URL ? new URL(e.LMS_URL).origin : null,
    /** Where IoT Studio's "Sign in with Kokoon LMS" button sends the browser. */
    ssoStartUrl: e.LMS_URL ? new URL('/iot-studio/sso-start', e.LMS_URL).toString() : null,
    ssoSecret: e.LMS_SSO_SECRET ?? '',
    apiSecret: e.LMS_API_SECRET ?? '',
    ssoIssuer: 'kokoon-lms',
    ssoAudience: 'kokoon-iot-studio',
    /** Max age of an SSO token and allowed clock skew, seconds. */
    ssoMaxLifetimeSec: 120,
    ssoClockSkewSec: 30,
    /** Server-to-server request signing window and idempotency memory, seconds. */
    apiMaxSkewSec: 300,
    idempotencyTtlSec: 24 * 3600,
    /** A reservation that never completes (crash) frees its Request-Id after this. */
    idempotencyPendingTtlSec: 120,
    publicBroker: e.MQTT_PUBLIC_BROKER_URL ? parseBrokerUrl(e.MQTT_PUBLIC_BROKER_URL) : null,
    credentialsMode: e.BROKER_CREDENTIALS_MODE,
    sharedDevice: { username: e.MQTT_DEVICE_USERNAME ?? '', password: e.MQTT_DEVICE_PASSWORD ?? '' },
    /** Backend broker identities a hardware id may never take (see isReservedHardwareId). */
    reservedAccounts: [e.MQTT_USERNAME, e.MQTT_DEVICE_USERNAME, e.MQTT_CLIENT_ID].filter((a): a is string => !!a),
    /** Signed LMS calls per minute (all callers holding LMS_API_SECRET share one bucket). */
    apiRateLimitPerMin: e.LMS_API_RATE_LIMIT_PER_MIN,
    /** Requests failing the signature check, per IP per minute. */
    apiUnsignedRateLimitPerMin: 600,
    /** `Origin: null` (e.g. a local HTML file from `npm run lms:sso`) is accepted on the SSO form only in development. */
    allowNullOriginSso: e.NODE_ENV === 'development',
  };
}
