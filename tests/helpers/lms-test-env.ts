/**
 * Turns the LMS integration on for one integration-test file. Import BEFORE
 * ./helpers (each test file runs in its own process, so this does not leak).
 * Values are random / test-only.
 */
import { randomBytes } from 'node:crypto';

export const LMS_TEST = {
  url: 'http://lms.test.kokoon.local',
  ssoSecret: randomBytes(48).toString('base64url'),
  apiSecret: randomBytes(48).toString('base64url'),
};

Object.assign(process.env, {
  LMS_INTEGRATION_ENABLED: 'true',
  LMS_URL: LMS_TEST.url,
  LMS_SSO_SECRET: LMS_TEST.ssoSecret,
  LMS_API_SECRET: LMS_TEST.apiSecret,
  MQTT_PUBLIC_BROKER_URL: 'mqtt://192.168.1.20:1883',
  BROKER_CREDENTIALS_MODE: 'shared',
  MQTT_DEVICE_USERNAME: 'esp32-device',
  MQTT_DEVICE_PASSWORD: randomBytes(12).toString('hex'),
  // One project (200 tokens) fits, a second one does not: exercises the token warning.
  FREE_PLAN_TOKENS: '300',
});
export {};
