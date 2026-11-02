/**
 * Try the Kokoon LMS integration without the LMS (development only).
 * Uses LMS_SSO_SECRET / LMS_API_SECRET from .env, i.e. it plays the LMS backend.
 *
 *   npm run lms:sso -- --sub u_test --email tester@kokoon.local --name "Test Student" [--next /devices] [--unverified]
 *       → writes a local HTML page that auto-posts a fresh SSO token (valid 60 s, single use)
 *
 *   npm run lms:device -- --hardware kk-esp32s3-test01 [--sub u_test --email … --name …]
 *                         [--program prog_demo_room] [--version r1] [--no-project] [--rotate]
 *   npm run lms:device -- --hardware kk-esp32s3-test01 --get       (B2: status)
 *   npm run lms:device -- --hardware kk-esp32s3-test01 --delete    (B3: disable + revoke)
 *       → sends a signed request and prints the response
 *
 * API base: IOT_API env var, default http://localhost:{PORT}{API_BASE_PATH}.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { loadEnv } from '../src/config/env.config';
import { lmsConfig } from '../src/config/lms.config';
import { LMS_HEADERS, signLmsRequest } from '../src/utils/lms-signature.util';

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i > 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : def;
};

const env = loadEnv();
if (env.NODE_ENV === 'production') {
  console.error('lms-dev is a development tool and refuses to run with NODE_ENV=production.');
  process.exit(1);
}
const cfg = lmsConfig();
const apiBase = (process.env.IOT_API ?? `http://localhost:${env.PORT}${env.API_BASE_PATH}`).replace(/\/+$/, '');
const user = { sub: opt('sub', 'u_test_student'), email: opt('email', 'lms.tester@kokoon.local'), name: opt('name', 'LMS Test Student') };

if (!cfg.enabled) console.warn('⚠ LMS_INTEGRATION_ENABLED is false in .env — the server will refuse these requests until you turn it on and restart it.\n');

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function sso() {
  if (!cfg.ssoSecret) throw new Error('LMS_SSO_SECRET is not set in .env');
  const token = jwt.sign({ email: user.email, email_verified: !flag('unverified'), name: user.name, jti: randomUUID() }, cfg.ssoSecret, {
    algorithm: 'HS256', issuer: cfg.ssoIssuer, audience: cfg.ssoAudience, subject: user.sub, expiresIn: 60,
  });
  const action = `${apiBase}/auth/lms/sso`;
  const html = `<!doctype html><meta charset="utf-8"><title>Signing in to IoT Studio…</title>
<body onload="document.forms[0].submit()"><p>Signing in to IoT Studio…</p>
<form method="post" action="${esc(action)}"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="next" value="${esc(opt('next', '/'))}"><noscript><button>Continue</button></noscript></form></body>`;
  const file = path.join(os.tmpdir(), `kokoon-lms-sso-${Date.now()}.html`);
  fs.writeFileSync(file, html, { mode: 0o600 });
  console.log(`SSO test page for ${user.name} <${user.email}> (lmsUserId ${user.sub}):\n\n  ${file}\n`);
  console.log('Open it in your browser within 60 seconds (the token works once).');
  console.log('A local file posts with "Origin: null", which the server accepts only in development.');
}

async function device() {
  if (!cfg.apiSecret) throw new Error('LMS_API_SECRET is not set in .env');
  const hardwareId = opt('hardware', 'kk-esp32s3-test01');
  const method = flag('delete') ? 'DELETE' : flag('get') ? 'GET' : 'PUT';
  const url = new URL(`${apiBase}/integrations/lms/devices/${encodeURIComponent(hardwareId)}${method === 'PUT' && flag('rotate') ? '?rotateCredentials=true' : ''}`);
  const body =
    method === 'PUT'
      ? JSON.stringify({
          user: { lmsUserId: user.sub, email: user.email, emailVerified: !flag('unverified'), name: user.name },
          device: { name: opt('device-name', 'Desk ESP32'), board: opt('board', 'ESP32-S3 DevKitC'), firmwareVersion: opt('version', 'r1') },
          program: { programId: opt('program', 'prog_demo_room'), name: opt('program-name', 'Room Monitor (test)'), version: opt('version', 'r1') },
          variables: [
            { key: 'temperature', displayName: 'Temperature', dataType: 'float', direction: 'telemetry', unit: '°C', min: 0, max: 50, blockId: 'blk_temp' },
            { key: 'led_state', displayName: 'LED', dataType: 'boolean', direction: 'bidirectional', blockId: 'blk_led' },
          ],
          project: { create: !flag('no-project') },
        })
      : '';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestId = randomUUID();
  const headers: Record<string, string> = {
    [LMS_HEADERS.TIMESTAMP]: timestamp,
    [LMS_HEADERS.REQUEST_ID]: requestId,
    [LMS_HEADERS.SIGNATURE]: signLmsRequest(cfg.apiSecret, timestamp, method, url.pathname + url.search, body),
  };
  if (body) headers['content-type'] = 'application/json';
  console.log(`${method} ${url.toString()}  (request id ${requestId})\n`);
  const res = await fetch(url, { method, headers, body: body || undefined });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    if (text) console.log(text);
  }
  if (res.ok && text.includes('"credentials":{')) console.log('\n(Device credentials are shown once — this is what the LMS injects into the firmware.)');
}

(command === 'sso' ? sso() : command === 'device' ? device() : Promise.reject(new Error('usage: lms-dev.ts sso|device [options] — see the header of scripts/lms-dev.ts')))
  .then(() => process.exit(0))
  .catch((err: Error) => {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  });
