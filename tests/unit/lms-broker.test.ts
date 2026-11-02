import '../helpers/test-env';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Response } from 'express';
import { isReservedHardwareId } from '../../src/config/lms.config';
import { isVerifiedLmsCall, lmsCallerKey } from '../../src/middleware/rate-limit.middleware';
import {
  BrokerCredentialsError,
  assertDeviceAccount,
  createDeviceCommands,
  createDynsecClient,
  deviceRoleAcls,
  updateDeviceCommands,
  type DynsecTransport,
} from '../../src/services/shared/broker-credentials.service';
import { chipInUseDetails, decideChipBinding } from '../../src/utils/lms-chip.util';
import { lmsBulkStatusBody, lmsHardwareId, lmsUpsertDeviceBody, lmsUpsertQuery } from '../../src/validations/integrations/lms.validation';

const ACCOUNTS = ['kokoon-backend', 'esp32-device', 'kokoon-backend'];

describe('reserved hardware ids', () => {
  it('reserves the backend, admin and simulator prefixes', () => {
    for (const h of ['kokoon-backend', 'kokoon-backend-1', 'kokoon-backendx', 'admin', 'admin-1', 'administrator', 'sandbox-abc', 'esp32-sim-1']) {
      assert.equal(isReservedHardwareId(h), true, h);
      assert.equal(lmsHardwareId.safeParse(h).success, false, h);
    }
  });

  it('reserves the configured broker accounts and their client-id forms', () => {
    assert.equal(isReservedHardwareId('esp32-device', ACCOUNTS), true);
    assert.equal(isReservedHardwareId('esp32-device-2', ACCOUNTS), true);
    assert.equal(isReservedHardwareId('iot-api', ['iot-api']), true);
    assert.equal(isReservedHardwareId('iot-api-1234', ['iot-api']), true);
    // The env names are not part of the static schema (the controller checks them).
    assert.equal(lmsHardwareId.safeParse('esp32-device').success, true);
  });

  it('keeps LMS-generated and ordinary ids', () => {
    for (const h of ['kk-esp32s3-7f3k9q2m', 'kk-brainboard-00000001', 'desk-board', 'kokoon-desk', 'esp32-devicex']) {
      assert.equal(isReservedHardwareId(h, ACCOUNTS), false, h);
    }
  });

  it('broker-credentials refuses to manage a reserved or malformed account', () => {
    for (const h of ['kokoon-backend', 'esp32-device', 'admin', 'sandbox-x', 'Bad Name', '']) {
      assert.throws(() => assertDeviceAccount(h, ACCOUNTS), (e: unknown) => e instanceof BrokerCredentialsError && !e.retryable, h);
    }
    assert.doesNotThrow(() => assertDeviceAccount('kk-esp32s3-7f3k9q2m', ACCOUNTS));
  });
});

describe('chip binding', () => {
  const A = 'a1b2c3d4e5f6';
  const B = '0011223344556677';

  it('keeps the binding when no chip is sent or it is the same chip', () => {
    assert.equal(decideChipBinding(A, undefined, false), 'keep');
    assert.equal(decideChipBinding(null, undefined, true), 'keep');
    assert.equal(decideChipBinding(A, A, false), 'keep');
    assert.equal(decideChipBinding(A, A, true), 'keep');
  });

  it('binds the first chip, refuses another one, replaces only on request', () => {
    assert.equal(decideChipBinding(undefined, A, false), 'bind');
    assert.equal(decideChipBinding(null, A, false), 'bind');
    assert.equal(decideChipBinding(A, B, false), 'mismatch');
    assert.equal(decideChipBinding(A, B, true), 'replace');
    assert.equal(decideChipBinding(null, B, true), 'replace');
  });

  it('names the other board only to its own owner', () => {
    assert.deepEqual(chipInUseDetails({ hardwareId: 'kk-a', ownerId: 'u1' }, 'u1'), { hardwareId: 'kk-a' });
    assert.equal(chipInUseDetails({ hardwareId: 'kk-a', ownerId: 'u1' }, 'u2'), undefined);
  });
});

describe('LMS request validation (chip, replaceChip, bulk status)', () => {
  const body = (device: Record<string, unknown> = {}) => ({
    user: { lmsUserId: 'u_1', email: 'a@b.co', emailVerified: true, name: 'A' },
    device: { name: 'Desk', board: 'ESP32-S3 DevKitC', ...device },
    program: { programId: 'prog_1', name: 'Room monitor' },
  });

  it('accepts an optional lowercase-hex chipId of 8–32 characters', () => {
    assert.ok(lmsUpsertDeviceBody.safeParse(body()).success);
    assert.equal(lmsUpsertDeviceBody.parse(body({ chipId: 'a1b2c3d4e5f6' })).device.chipId, 'a1b2c3d4e5f6');
    assert.ok(lmsUpsertDeviceBody.safeParse(body({ chipId: 'f'.repeat(32) })).success);
    for (const c of ['A1B2C3D4E5F6', 'a1b2c3', 'f'.repeat(33), 'a1b2-c3d4e5', 'zzzzzzzz', 12345678, null]) {
      assert.equal(lmsUpsertDeviceBody.safeParse(body({ chipId: c })).success, false, String(c));
    }
  });

  it('parses replaceChip and rotateCredentials query flags', () => {
    assert.deepEqual(lmsUpsertQuery.parse({ rotateCredentials: 'true', replaceChip: 'true' }), { rotateCredentials: true, replaceChip: true });
    assert.deepEqual(lmsUpsertQuery.parse({ replaceChip: 'false' }), { replaceChip: false });
    assert.equal(lmsUpsertQuery.safeParse({ replaceChip: 'yes' }).success, false);
  });

  it('bulk status takes 1..200 well-formed hardware ids and nothing else', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `kk-esp32-${String(i).padStart(4, '0')}`);
    assert.ok(lmsBulkStatusBody.safeParse({ hardwareIds: ids(1) }).success);
    assert.ok(lmsBulkStatusBody.safeParse({ hardwareIds: ids(200) }).success);
    assert.equal(lmsBulkStatusBody.safeParse({ hardwareIds: [] }).success, false);
    assert.equal(lmsBulkStatusBody.safeParse({ hardwareIds: ids(201) }).success, false);
    assert.equal(lmsBulkStatusBody.safeParse({ hardwareIds: ['KK-UPPER'] }).success, false);
    assert.equal(lmsBulkStatusBody.safeParse({ hardwareIds: ['ab'] }).success, false);
    assert.equal(lmsBulkStatusBody.safeParse({ hardwareIds: [42] }).success, false);
    assert.equal(lmsBulkStatusBody.safeParse({ hardwareIds: ids(1), extra: true }).success, false);
    assert.equal(lmsBulkStatusBody.safeParse({}).success, false);
  });
});

describe('LMS rate-limit keying', () => {
  const res = (locals: Record<string, unknown>) => ({ locals }) as unknown as Response;

  it('counts only unverified requests per IP and verified ones per caller', () => {
    assert.equal(isVerifiedLmsCall(res({})), false);
    assert.equal(isVerifiedLmsCall(res({ lmsRejection: new Error('x') })), false);
    assert.equal(isVerifiedLmsCall(res({ lms: { requestId: 'r', rawBody: Buffer.alloc(0) } })), true);
    assert.equal(lmsCallerKey(), 'lms');
  });
});

/* ------------------------------------------------ dynsec over a fake transport */

class FakeBroker implements DynsecTransport {
  connected = true;
  published: { topic: string; payload: string }[] = [];
  subscribeCalls = 0;
  failSubscribe = 0;
  failPublish = false;
  private onPayload: ((p: string) => void) | null = null;
  /** Answer each published command; return undefined to stay silent. */
  constructor(private answer: (cmd: Record<string, unknown>) => Record<string, unknown> | undefined = (c) => ({ command: c.command })) {}

  isConnected() {
    return this.connected;
  }
  async subscribe(topic: string, onPayload: (p: string) => void) {
    this.subscribeCalls++;
    assert.equal(topic, '$CONTROL/dynamic-security/v1/response');
    if (this.failSubscribe-- > 0) throw new Error('subscribe refused');
    this.onPayload = onPayload;
  }
  async publish(topic: string, payload: string) {
    if (this.failPublish) throw new Error('socket closed');
    this.published.push({ topic, payload });
    const { commands } = JSON.parse(payload) as { commands: Record<string, unknown>[] };
    const responses = commands.map((c) => this.answer(c)).map((r, i) => (r ? { ...r, correlationData: commands[i]!.correlationData } : null)).filter(Boolean);
    // Like Mosquitto 2.0: one response message, published after the request; plus noise from another instance.
    setImmediate(() => {
      this.onPayload?.('not json');
      this.onPayload?.(JSON.stringify({ responses: [{ command: 'createClient', correlationData: 'someone-else' }] }));
      if (responses.length) this.onPayload?.(JSON.stringify({ responses: responses.reverse() }));
    });
  }
}

describe('Mosquitto dynamic-security client', () => {
  it('sends all commands in ONE $CONTROL message, each with its own correlationData, and maps answers back in order', async () => {
    const broker = new FakeBroker((c) => ({ command: c.command, ...(c.command === 'createRole' ? { error: 'Role already exists' } : {}) }));
    let n = 0;
    const client = createDynsecClient(broker, { newId: () => `id-${++n}` });
    const out = await client.send(createDeviceCommands('kk-a1', 'kokoon/devices/kk-a1', 'pw'));
    assert.equal(broker.published.length, 1);
    assert.equal(broker.published[0]!.topic, '$CONTROL/dynamic-security/v1');
    const sent = (JSON.parse(broker.published[0]!.payload) as { commands: { command: string; correlationData: string }[] }).commands;
    assert.deepEqual(sent.map((c) => [c.command, c.correlationData]), [['createRole', 'id-1'], ['createClient', 'id-2']]);
    // Answers came back reversed; they are returned in request order.
    assert.deepEqual(out.map((r) => [r.command, r.error]), [['createRole', 'Role already exists'], ['createClient', undefined]]);
    assert.equal(client.pending(), 0);
    assert.equal(broker.subscribeCalls, 1);
    await client.send([{ command: 'getClient', username: 'kk-a1' }]);
    assert.equal(broker.subscribeCalls, 1, 'subscribes once');
    assert.deepEqual(await client.send([]), []);
    assert.equal(broker.published.length, 2, 'an empty batch sends nothing');
  });

  it('times out with a retryable error naming the unanswered commands', async () => {
    const broker = new FakeBroker((c) => (c.command === 'deleteRole' ? undefined : { command: c.command }));
    const client = createDynsecClient(broker, { timeoutMs: 30 });
    await assert.rejects(
      client.send([{ command: 'deleteClient', username: 'kk-a1' }, { command: 'deleteRole', rolename: 'device-kk-a1' }]),
      (e: unknown) => e instanceof BrokerCredentialsError && e.retryable && /deleteRole/.test(e.message) && !/deleteClient/.test(e.message),
    );
    assert.equal(client.pending(), 0);
  });

  it('fails fast and retryable when the broker is down or the request cannot be sent', async () => {
    const broker = new FakeBroker();
    const client = createDynsecClient(broker, { timeoutMs: 1000 });
    broker.connected = false;
    await assert.rejects(client.send([{ command: 'getClient', username: 'x' }]), (e: unknown) => e instanceof BrokerCredentialsError && e.retryable);
    broker.connected = true;
    broker.failPublish = true;
    await assert.rejects(client.send([{ command: 'getClient', username: 'x' }]), (e: unknown) => e instanceof BrokerCredentialsError && e.retryable);
    assert.equal(client.pending(), 0);
  });

  it('does not remember a failed response subscription', async () => {
    const broker = new FakeBroker();
    broker.failSubscribe = 1;
    const client = createDynsecClient(broker, { timeoutMs: 1000 });
    await assert.rejects(client.send([{ command: 'getClient', username: 'x' }]), (e: unknown) => e instanceof BrokerCredentialsError && e.retryable);
    const [r] = await client.send([{ command: 'getClient', username: 'x' }]);
    assert.equal(r!.command, 'getClient');
    assert.equal(broker.subscribeCalls, 2);
  });
});

describe('dynsec device account commands', () => {
  const prefix = 'kokoon/devices/kk-a1';

  it('creates role (with all ACLs) and client (clientid = username = hardwareId) together', () => {
    const [role, client] = createDeviceCommands('kk-a1', prefix, 'pw');
    assert.deepEqual(role, { command: 'createRole', rolename: 'device-kk-a1', acls: deviceRoleAcls(prefix) });
    assert.deepEqual(client, { command: 'createClient', username: 'kk-a1', password: 'pw', clientid: 'kk-a1', roles: [{ rolename: 'device-kk-a1' }] });
    assert.deepEqual(
      deviceRoleAcls(prefix).map((a) => `${a.acltype} ${a.topic} ${a.allow}`),
      [
        `publishClientSend ${prefix}/telemetry/# true`,
        `publishClientSend ${prefix}/ack/# true`,
        `publishClientSend ${prefix}/availability true`,
        `subscribePattern ${prefix}/command/# true`,
        `unsubscribePattern ${prefix}/command/# true`,
      ],
    );
  });

  it('re-issues an existing account: new password, only the missing fixes, never a duplicate addClientRole', () => {
    const own = { clientid: 'kk-a1', roles: [{ rolename: 'device-kk-a1' }] };
    assert.deepEqual(updateDeviceCommands('kk-a1', prefix, 'pw', { roleExisted: false, client: own }).map((c) => c.command), ['setClientPassword']);
    assert.deepEqual(updateDeviceCommands('kk-a1', prefix, 'pw', { roleExisted: true, client: { ...own, disabled: true } }).map((c) => c.command), ['modifyRole', 'setClientPassword', 'enableClient']);
    assert.deepEqual(updateDeviceCommands('kk-a1', prefix, 'pw', { roleExisted: false, client: { clientid: 'kk-a1' } }).map((c) => c.command), ['setClientPassword', 'addClientRole']);
    const [modify] = updateDeviceCommands('kk-a1', prefix, 'pw', { roleExisted: true, client: own });
    assert.deepEqual(modify, { command: 'modifyRole', rolename: 'device-kk-a1', acls: deviceRoleAcls(prefix) });
  });

  it('refuses an existing account that is not exactly this device’s', () => {
    const refuse = (client: Record<string, unknown>) =>
      assert.throws(() => updateDeviceCommands('kk-a1', prefix, 'pw', { roleExisted: false, client }), (e: unknown) => e instanceof BrokerCredentialsError && !e.retryable);
    refuse({ roles: [{ rolename: 'device-kk-a1' }] }); // no client id binding
    refuse({ clientid: 'other', roles: [] });
    refuse({ clientid: 'kk-a1', roles: [{ rolename: 'admin' }] });
    refuse({ clientid: 'kk-a1', roles: [{ rolename: 'device-kk-a1' }, { rolename: 'kokoon-backend' }] });
  });
});
