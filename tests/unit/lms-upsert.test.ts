import '../helpers/lms-test-env';
import '../helpers/test-env';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { Types } from 'mongoose';
import { LIMITS } from '../../src/constants/app.constants';
import type { ConnectionState } from '../../src/constants/mqtt.constants';
import { deviceDao } from '../../src/dao/device.dao';
import { projectDao } from '../../src/dao/project.dao';
import type { DeviceDoc } from '../../src/models/device.model';
import { lmsIntegrationService } from '../../src/services/integrations/lms-integration.service';
import { auditLogService } from '../../src/services/private/audit-log.service';
import { activityService } from '../../src/services/shared/activity.service';
import { brokerCredentials, type BrokerCredentialProvider } from '../../src/services/shared/broker-credentials.service';
import { deviceRegistry } from '../../src/services/shared/device-registry.service';
import { lmsIdentityService } from '../../src/services/shared/lms-identity.service';
import { mqttConnection } from '../../src/services/shared/mqtt-connection.service';
import { realtimeService } from '../../src/services/shared/realtime.service';
import { LmsApiError } from '../../src/utils/lms-api-error.util';
import { lmsUpsertDeviceBody } from '../../src/validations/integrations/lms.validation';

/** B1/B3 orchestration with the DAOs, broker and registry replaced by in-memory fakes (no Mongo, Redis or MQTT). */

const HW = 'kk-esp32s3-7f3k9q2m';
const owner = { _id: new Types.ObjectId(), role: 'user' };
const body = (projectCreate = false) =>
  lmsUpsertDeviceBody.parse({
    user: { lmsUserId: 'u_1', email: 'a@b.co', emailVerified: true, name: 'A' },
    device: { name: 'Desk', board: 'ESP32-S3 DevKitC' },
    program: { programId: 'prog_1', name: 'Room monitor' },
    variables: [],
    project: { create: projectCreate },
  });

let stored: DeviceDoc | null;
let activeCount: number;
let issued: number;
const asAny = (f: unknown) => f as never;

function fakeDevice(over: Partial<DeviceDoc> = {}): DeviceDoc {
  return {
    _id: new Types.ObjectId(), ownerId: owner._id, name: 'Desk', hardwareId: HW, topicPrefix: `kokoon/devices/${HW}`, board: 'ESP32-S3 DevKitC',
    origin: 'lms', simulated: false, status: 'active', capabilities: [], credentialsIssuedAt: null, ...over,
  } as unknown as DeviceDoc;
}

beforeEach(() => {
  stored = null;
  activeCount = 0;
  issued = 0;
  const provider: BrokerCredentialProvider = {
    mode: 'mosquitto-dynsec',
    bootstrap: async () => undefined,
    issue: async (username) => ({ username, password: `pw-${++issued}`, clientId: username }) as never,
    revoke: async () => undefined,
  };
  mock.method(brokerCredentials, 'provider', () => provider);
  mock.method(lmsIdentityService, 'resolveUser', asAny(async () => ({ user: owner, outcome: 'existing' })));
  mock.method(deviceDao, 'findByHardwareId', asAny(async () => (stored ? { ...stored } : null)));
  mock.method(deviceDao, 'countActiveOwned', asAny(async () => activeCount));
  mock.method(deviceDao, 'existsHardwareOrPrefix', asAny(async () => false));
  mock.method(deviceDao, 'findActiveByChip', asAny(async () => null));
  mock.method(deviceDao, 'create', asAny(async (d: Partial<DeviceDoc>) => (stored = fakeDevice(d))));
  mock.method(deviceDao, 'lmsSync', asAny(async (_id: string, set: { status: DeviceDoc['status']; credentialsOwed?: boolean }) => {
    stored = { ...stored!, status: set.status, ...(set.credentialsOwed ? { credentialsIssuedAt: null } : {}) };
    return { ...stored };
  }));
  mock.method(deviceDao, 'markCredentialsIssued', asAny(async (_id: string, at: Date) => {
    stored = { ...stored!, credentialsIssuedAt: at };
  }));
  mock.method(deviceDao, 'lmsDisable', asAny(async () => {
    stored = { ...stored!, status: 'disabled', credentialsIssuedAt: null };
  }));
  mock.method(deviceDao, 'listOwned', asAny(async () => []));
  mock.method(activityService, 'record', asAny(async () => undefined));
  mock.method(auditLogService, 'record', asAny(async () => undefined));
  mock.method(deviceRegistry, 'refresh', async () => undefined);
  mock.method(deviceRegistry, 'reloadDevice', async () => undefined);
  mock.method(deviceRegistry, 'removeDevice', () => undefined);
});

afterEach(() => mock.restoreAll());

const callsOf = (fn: unknown) => (fn as { mock: { calls: { arguments: unknown[] }[] } }).mock.calls;

describe('LMS B1 credential delivery', () => {
  it('a request that fails after the broker issued the password still owes credentials to its retry', async () => {
    const sync = mock.method(projectDao, 'findOwnedByLmsProgram', asAny(async () => {
      throw new Error('mongo blip');
    }));
    await assert.rejects(lmsIntegrationService.upsertDevice(HW, body(true), { rotateCredentials: false }), /mongo blip/);
    assert.equal(issued, 1);
    assert.equal(stored!.credentialsIssuedAt, null, 'not marked delivered: the response never reached the LMS');
    assert.equal(callsOf(deviceDao.markCredentialsIssued).length, 0);

    sync.mock.mockImplementation(asAny(async () => null));
    const retry = await lmsIntegrationService.upsertDevice(HW, body(false), { rotateCredentials: false });
    assert.equal(retry.created, false);
    assert.equal(retry.body.credentials?.password, 'pw-2');
    // (assert.equal above narrowed the property to null)
    assert.ok((stored!.credentialsIssuedAt as Date | null) instanceof Date);

    const again = await lmsIntegrationService.upsertDevice(HW, body(false), { rotateCredentials: false });
    assert.equal(again.body.credentials, null, 'delivered once: a plain re-flash keeps the password');
    assert.equal(issued, 2);
  });
});

describe('LMS B1 device cap', () => {
  it('re-enabling a disabled board counts against the cap', async () => {
    stored = fakeDevice({ status: 'disabled' });
    activeCount = LIMITS.MAX_DEVICES_PER_USER;
    await assert.rejects(lmsIntegrationService.upsertDevice(HW, body(), { rotateCredentials: false }), (e: unknown) => e instanceof LmsApiError && e.status === 422 && e.code === 'validation_failed');
    assert.equal(callsOf(deviceDao.lmsSync).length, 0);
    assert.equal(stored.status, 'disabled');

    activeCount = LIMITS.MAX_DEVICES_PER_USER - 1;
    const r = await lmsIntegrationService.upsertDevice(HW, body(), { rotateCredentials: false });
    assert.equal(stored.status, 'active');
    assert.ok(r.body.credentials, 'a re-enabled board gets new credentials');
  });

  it('an active board at the cap can still be re-flashed', async () => {
    stored = fakeDevice({ credentialsIssuedAt: new Date() });
    activeCount = LIMITS.MAX_DEVICES_PER_USER;
    const r = await lmsIntegrationService.upsertDevice(HW, body(), { rotateCredentials: false });
    assert.equal(r.body.credentials, null);
  });
});

describe('LMS registry updates', () => {
  it('B1 reloads only its own device', async () => {
    mock.method(projectDao, 'findOwnedByLmsProgram', asAny(async () => null));
    const r = await lmsIntegrationService.upsertDevice(HW, body(), { rotateCredentials: false });
    assert.equal(callsOf(deviceRegistry.refresh).length, 0);
    assert.deepEqual(callsOf(deviceRegistry.reloadDevice).map((c) => c.arguments[0]), [r.body.deviceId]);
  });

  it('B3 removes only its own device', async () => {
    stored = fakeDevice({ credentialsIssuedAt: new Date() });
    await lmsIntegrationService.disableDevice(HW);
    assert.equal(callsOf(deviceRegistry.refresh).length, 0);
    assert.deepEqual(callsOf(deviceRegistry.removeDevice).map((c) => c.arguments[0]), [String(stored!._id)]);
    assert.equal(stored!.status, 'disabled');
  });
});

describe('LMS B1 presence when a new login cuts the old one off', () => {
  // The broker disconnects a board whose password changed WITHOUT its Last Will: B1 must say it went offline.
  let state: ConnectionState | null;
  const runtime = () => (state ? { state, lastSeen: 1, since: 1, messageCount: 1, telemetrySeen: true } : null);
  const clears = () => callsOf(mqttConnection.publish).map((c) => c.arguments);
  const clearCall = [`kokoon/devices/${HW}/availability`, '', { qos: 1, retain: true }];
  const disconnectedEvents = () => callsOf(realtimeService.toDevice).filter((c) => (c.arguments[1] as { data: { runtime: { state: string } } }).data.runtime.state === 'disconnected');
  const disconnectActivity = () => callsOf(activityService.record).filter((c) => (c.arguments[0] as { type: string }).type === 'device.disconnected');

  beforeEach(() => {
    state = 'connected';
    mock.method(deviceRegistry, 'runtimeOf', runtime);
    mock.method(deviceRegistry, 'setState', (_id: string, next: ConnectionState) => {
      if (!state || state === next) return false;
      state = next;
      return true;
    });
    mock.method(mqttConnection, 'isConnected', () => true);
    mock.method(mqttConnection, 'publish', async () => undefined);
    mock.method(realtimeService, 'toDevice', () => undefined);
  });

  it('"Reset connection" (rotateCredentials) marks a connected board disconnected, tells its viewers and clears the retained "online"', async () => {
    stored = fakeDevice({ credentialsIssuedAt: new Date() });
    const r = await lmsIntegrationService.upsertDevice(HW, body(), { rotateCredentials: true });
    assert.ok(r.body.credentials, 'a new login was issued');
    assert.equal(state, 'disconnected');
    assert.equal(disconnectedEvents().length, 1);
    assert.equal(disconnectActivity().length, 1);
    assert.deepEqual(clears(), [clearCall]);
  });

  it('a chip replace does the same for the old chip', async () => {
    stored = fakeDevice({ credentialsIssuedAt: new Date(), chipId: 'aaaaaaaa' });
    const b = body();
    b.device.chipId = 'bbbbbbbb';
    const r = await lmsIntegrationService.upsertDevice(HW, b, { rotateCredentials: false, replaceChip: true });
    assert.ok(r.body.credentials);
    assert.equal(state, 'disconnected');
    assert.deepEqual(clears(), [clearCall]);
  });

  it('a reset that fails after the password changed still shows the board offline', async () => {
    stored = fakeDevice({ credentialsIssuedAt: new Date() });
    mock.method(projectDao, 'findOwnedByLmsProgram', asAny(async () => {
      throw new Error('mongo blip');
    }));
    await assert.rejects(lmsIntegrationService.upsertDevice(HW, body(true), { rotateCredentials: true }), /mongo blip/);
    assert.equal(state, 'disconnected');
    assert.deepEqual(clears(), [clearCall]);
  });

  it('a reset whose broker answer was lost (503) still shows the board offline', async () => {
    const lost: BrokerCredentialProvider = {
      mode: 'mosquitto-dynsec', bootstrap: async () => undefined, revoke: async () => undefined,
      issue: async () => {
        throw new Error('Mosquitto dynamic-security did not answer setClientPassword within 5000 ms');
      },
    };
    mock.method(brokerCredentials, 'provider', () => lost);
    stored = fakeDevice({ credentialsIssuedAt: new Date() });
    await assert.rejects(lmsIntegrationService.upsertDevice(HW, body(), { rotateCredentials: true }), (e: unknown) => e instanceof LmsApiError && e.status === 503);
    assert.equal(state, 'disconnected');
    assert.deepEqual(clears(), [clearCall]);
  });

  it('a board re-enabled after B3 does not come back with its stale "connected"', async () => {
    stored = fakeDevice({ status: 'disabled' });
    const r = await lmsIntegrationService.upsertDevice(HW, body(), { rotateCredentials: false });
    assert.ok(r.body.credentials);
    assert.equal(state, 'disconnected');
    assert.deepEqual(clears(), [clearCall], 'cleared once');
  });

  it('a plain re-flash keeps the login, so the board stays connected', async () => {
    stored = fakeDevice({ credentialsIssuedAt: new Date() });
    const r = await lmsIntegrationService.upsertDevice(HW, body(), { rotateCredentials: false });
    assert.equal(r.body.credentials, null);
    assert.equal(state, 'connected');
    assert.equal(disconnectedEvents().length, 0);
    assert.deepEqual(clears(), []);
  });

  it('a board that never connected stays "waiting" (nothing to announce), but the retained topic is still cleared', async () => {
    state = 'waiting';
    stored = fakeDevice({ credentialsIssuedAt: new Date() });
    await lmsIntegrationService.upsertDevice(HW, body(), { rotateCredentials: true });
    assert.equal(state, 'waiting');
    assert.equal(disconnectedEvents().length, 0);
    assert.equal(disconnectActivity().length, 0);
    assert.deepEqual(clears(), [clearCall]);
  });

  it('a board that is already offline is not announced twice', async () => {
    state = 'disconnected';
    stored = fakeDevice({ credentialsIssuedAt: new Date() });
    await lmsIntegrationService.upsertDevice(HW, body(), { rotateCredentials: true });
    assert.equal(disconnectActivity().length, 0);
    assert.deepEqual(clears(), [clearCall]);
  });

  it('a brand-new board has no old login to cut off', async () => {
    state = 'waiting';
    const r = await lmsIntegrationService.upsertDevice(HW, body(), { rotateCredentials: true });
    assert.equal(r.created, true);
    assert.deepEqual(clears(), []);
  });

  it('the shared dev account keeps working, so a rotation there cuts nothing off', async () => {
    const shared: BrokerCredentialProvider = { mode: 'shared', bootstrap: async () => undefined, issue: async (username) => ({ username, password: 'shared' }), revoke: async () => undefined };
    mock.method(brokerCredentials, 'provider', () => shared);
    stored = fakeDevice({ credentialsIssuedAt: new Date() });
    const r = await lmsIntegrationService.upsertDevice(HW, body(), { rotateCredentials: true });
    assert.ok(r.body.credentials);
    assert.equal(state, 'connected');
    assert.deepEqual(clears(), []);
  });
});
