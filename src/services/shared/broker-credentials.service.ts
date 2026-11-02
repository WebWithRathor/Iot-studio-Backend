import { randomBytes, randomUUID } from 'node:crypto';
import { isReservedHardwareId, lmsConfig } from '../../config/lms.config';
import { mqttConfig } from '../../config/mqtt.config';
import { isProduction } from '../../config/env.config';
import type { TransportMessage } from '../../types/mqtt.types';
import { channel } from '../../utils/logger.util';
import { HARDWARE_ID } from '../../utils/mqtt-topic.util';
import { mqttConnection } from './mqtt-connection.service';

/**
 * Broker accounts for real devices flashed from the Kokoon LMS.
 *
 *   shared            — development only: every device gets the same dev
 *                       account (MQTT_DEVICE_USERNAME / MQTT_DEVICE_PASSWORD).
 *                       Its broker ACL is not per device, so one board could
 *                       publish as another. Refused in production.
 *   mosquitto-dynsec  — one broker client per device, created through
 *                       Mosquitto's dynamic-security plugin over the backend's
 *                       own MQTT connection, with a role that only allows the
 *                       device's own namespace:
 *                         publish   {prefix}/telemetry/#, {prefix}/ack/#, {prefix}/availability
 *                         subscribe {prefix}/command/#
 *                       username = clientid = hardwareId, so a reserved name
 *                       (backend / shared account) is never touched.
 *
 * Passwords are generated here, returned once to the caller and never
 * stored by IoT Studio (the broker keeps only its own salted hash).
 * Failures throw BrokerCredentialsError.
 */

export interface DeviceCredentials {
  username: string;
  password: string;
}

export interface BrokerCredentialProvider {
  readonly mode: 'shared' | 'mosquitto-dynsec';
  /** Called once at startup (after MQTT is connected). */
  bootstrap(): Promise<void>;
  /** Create the device's account, or give it a NEW password if it exists (idempotent; old password stops working). */
  issue(hardwareId: string, topicPrefix: string): Promise<DeviceCredentials>;
  /** Remove the device's account so it can no longer connect. */
  revoke(hardwareId: string): Promise<void>;
}

const log = () => channel('mqtt');

/* --------------------------------------------------------------- shared */

const sharedProvider: BrokerCredentialProvider = {
  mode: 'shared',
  async bootstrap() {
    if (isProduction()) throw new Error('BROKER_CREDENTIALS_MODE=shared cannot be used in production');
  },
  async issue() {
    const { username, password } = lmsConfig().sharedDevice;
    return { username, password };
  },
  async revoke() {
    /* shared dev account: nothing per device to revoke */
  },
};

/* ------------------------------------------------- mosquitto dynamic security */

/*
 * Mosquitto 2.0 dynamic-security plugin (checked against the v2.0.22 sources):
 *   request  $CONTROL/dynamic-security/v1           {"commands":[{"command":"…", …, "correlationData":"…"}]}
 *   response $CONTROL/dynamic-security/v1/response  {"responses":[{"command":"…","error"?:"…","data"?:{…},"correlationData"?:"…"}]}
 * Commands of one message run in order and each answer echoes its correlationData.
 * The 2.0 plugin rewrites its whole JSON config after EVERY successful mutating
 * command (no batching), so a device operation uses as few of them as possible:
 * a new device is createRole{acls} + createClient{roles} in ONE message (2 saves).
 * Errors used here: "Client already exists", "Role already exists", "… not found".
 * addClientRole on a role the client already has answers "Internal error", so
 * existing accounts are read with getClient first.
 */

const CONTROL = '$CONTROL/dynamic-security/v1';
const RESPONSE = `${CONTROL}/response`;
const TIMEOUT_MS = 5000;

export interface DynsecResponse {
  command: string;
  error?: string;
  data?: Record<string, unknown>;
  correlationData?: string;
}
export type DynsecCommand = Record<string, unknown> & { command: string };

/** What the dynsec client needs from the MQTT connection (a fake one in unit tests). */
export interface DynsecTransport {
  isConnected(): boolean;
  subscribe(topic: string, onPayload: (payload: string) => void): Promise<unknown>;
  publish(topic: string, payload: string): Promise<void>;
}

/** A broker account operation failed. retryable = the broker was unreachable or did not answer. */
export class BrokerCredentialsError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'BrokerCredentialsError';
  }
}

/** Request/response over $CONTROL: one message per call, every command correlated, one timeout per message. */
export function createDynsecClient(transport: DynsecTransport, opts: { timeoutMs?: number; newId?: () => string } = {}) {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const newId = opts.newId ?? randomUUID;
  const waiting = new Map<string, (r: DynsecResponse) => void>();
  let subscribed: Promise<unknown> | null = null;

  function onPayload(payload: string) {
    let body: { responses?: unknown };
    try {
      body = JSON.parse(payload) as { responses?: unknown };
    } catch {
      return;
    }
    if (!Array.isArray(body?.responses)) return;
    for (const r of body.responses as DynsecResponse[]) {
      const id = typeof r?.correlationData === 'string' ? r.correlationData : undefined;
      const done = id ? waiting.get(id) : undefined;
      if (!done) continue; // another backend instance's request, or one that already timed out
      waiting.delete(id!);
      done(r);
    }
  }

  async function ensureSubscribed() {
    // A failed subscribe is not remembered: the next call tries again.
    subscribed ??= transport.subscribe(RESPONSE, onPayload).catch((err: unknown) => {
      subscribed = null;
      throw err;
    });
    await subscribed;
  }

  return {
    /** Send the commands in ONE $CONTROL message; resolves with one response per command, in order. */
    async send(commands: DynsecCommand[]): Promise<DynsecResponse[]> {
      if (!commands.length) return [];
      if (!transport.isConnected()) throw new BrokerCredentialsError('The MQTT broker is not connected, so broker accounts cannot be changed right now.', true);
      try {
        await ensureSubscribed();
      } catch (err) {
        throw new BrokerCredentialsError(`Could not subscribe to ${RESPONSE}: ${(err as Error).message}`, true);
      }
      const ids = commands.map(() => newId());
      const tagged = commands.map((c, i) => ({ ...c, correlationData: ids[i]! }));
      const results: DynsecResponse[] = [];
      let left = commands.length;
      let timer: NodeJS.Timeout | undefined;
      const answered = new Promise<DynsecResponse[]>((resolve, reject) => {
        timer = setTimeout(() => {
          ids.forEach((id) => waiting.delete(id));
          const missing = tagged.filter((_, i) => !results[i]).map((c) => c.command);
          reject(new BrokerCredentialsError(`Mosquitto dynamic-security did not answer ${missing.join(', ')} within ${timeoutMs} ms`, true));
        }, timeoutMs);
        timer.unref?.();
        ids.forEach((id, i) =>
          waiting.set(id, (r) => {
            results[i] = r;
            if (--left > 0) return;
            clearTimeout(timer);
            resolve(results);
          }),
        );
      });
      try {
        await transport.publish(CONTROL, JSON.stringify({ commands: tagged }));
      } catch (err) {
        clearTimeout(timer);
        ids.forEach((id) => waiting.delete(id));
        throw new BrokerCredentialsError(`Could not send to ${CONTROL}: ${(err as Error).message}`, true);
      }
      return answered;
    },
    /** Requests still waiting for an answer (tests, diagnostics). */
    pending: () => waiting.size,
  };
}

const ALREADY = /already exists/i;
const MISSING = /not found/i;
const isAlready = (r: DynsecResponse) => !!r.error && ALREADY.test(r.error);

function check(responses: DynsecResponse[], tolerate: RegExp | null = null): void {
  const bad = responses.find((r) => r.error && !(tolerate && tolerate.test(r.error)));
  if (bad) throw new BrokerCredentialsError(`Mosquitto dynamic-security “${bad.command}” failed: ${bad.error}`, false);
}

interface DynsecClientInfo {
  username?: string;
  clientid?: string;
  disabled?: boolean;
  roles?: { rolename: string }[];
}
const clientOf = (r: DynsecResponse): DynsecClientInfo => ((r.data?.client ?? {}) as DynsecClientInfo);
const rolesOf = (c: DynsecClientInfo) => (Array.isArray(c.roles) ? c.roles.map((r) => r.rolename) : []);

/** Never manage the backend's own account, the shared device account or another reserved name, whatever the caller validated. */
export function assertDeviceAccount(hardwareId: string, reservedAccounts: readonly string[] = lmsConfig().reservedAccounts): void {
  if (!HARDWARE_ID.test(hardwareId) || isReservedHardwareId(hardwareId, reservedAccounts)) {
    throw new BrokerCredentialsError(`Refusing to manage broker account “${hardwareId}”: it is not a device account.`, false);
  }
}

export const deviceRole = (hardwareId: string) => `device-${hardwareId}`;
const BACKEND_ROLE = 'kokoon-backend';

/** The device's own namespace, nothing else. */
export function deviceRoleAcls(prefix: string) {
  return [
    { acltype: 'publishClientSend', topic: `${prefix}/telemetry/#`, priority: 0, allow: true },
    { acltype: 'publishClientSend', topic: `${prefix}/ack/#`, priority: 0, allow: true },
    { acltype: 'publishClientSend', topic: `${prefix}/availability`, priority: 0, allow: true },
    { acltype: 'subscribePattern', topic: `${prefix}/command/#`, priority: 0, allow: true },
    { acltype: 'unsubscribePattern', topic: `${prefix}/command/#`, priority: 0, allow: true },
  ];
}

/** New device: role with its ACLs + client bound to clientid = hardwareId, in one message. */
export function createDeviceCommands(hardwareId: string, prefix: string, password: string): DynsecCommand[] {
  const rolename = deviceRole(hardwareId);
  return [
    { command: 'createRole', rolename, acls: deviceRoleAcls(prefix) },
    { command: 'createClient', username: hardwareId, password, clientid: hardwareId, roles: [{ rolename }] },
  ];
}

/**
 * The account already existed (re-issue, rotation, retry after a lost answer):
 * reset the role's ACLs if the role was there before, set the new password
 * (this disconnects a board using the old one), re-enable, attach the role.
 * Refuses an account that is not exactly this device's.
 */
export function updateDeviceCommands(hardwareId: string, prefix: string, password: string, existing: { roleExisted: boolean; client: DynsecClientInfo }): DynsecCommand[] {
  const rolename = deviceRole(hardwareId);
  const roles = rolesOf(existing.client);
  if (existing.client.clientid !== hardwareId || roles.some((r) => r !== rolename)) {
    throw new BrokerCredentialsError(`Broker account “${hardwareId}” exists but is not this device's account (client id or roles differ); it was not changed.`, false);
  }
  return [
    ...(existing.roleExisted ? [{ command: 'modifyRole', rolename, acls: deviceRoleAcls(prefix) }] : []),
    { command: 'setClientPassword', username: hardwareId, password },
    ...(existing.client.disabled ? [{ command: 'enableClient', username: hardwareId }] : []),
    ...(roles.includes(rolename) ? [] : [{ command: 'addClientRole', username: hardwareId, rolename }]),
  ];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** After the broker kicked the backend: wait for MQTT.js to reconnect and re-subscribe. */
async function reconnected(timeoutMs = 15_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  await sleep(1000);
  while (!mqttConnection.isConnected()) {
    if (Date.now() > until) return false;
    await sleep(250);
  }
  await sleep(500);
  return true;
}

let client: ReturnType<typeof createDynsecClient> | null = null;
const dynsec = (commands: DynsecCommand[]) =>
  (client ??= createDynsecClient({
    isConnected: () => mqttConnection.isConnected(),
    subscribe: (topic, onPayload) => mqttConnection.subscribe(topic, (m: TransportMessage) => onPayload(m.payload)),
    publish: (topic, payload) => mqttConnection.publish(topic, payload, { qos: 1 }),
  })).send(commands);

const dynsecProvider: BrokerCredentialProvider = {
  mode: 'mosquitto-dynsec',

  /**
   * The broker's dynsec admin is the backend's own MQTT account. Give it a
   * role that may also publish/subscribe the whole Kokoon namespace (the
   * dynsec default denies client publishes). Safe to run on every start.
   */
  async bootstrap() {
    const root = mqttConfig().topicRoot.split('/')[0];
    const backendUser = mqttConfig().username;
    if (!backendUser) throw new Error('mosquitto-dynsec needs MQTT_USERNAME (the dynsec admin account)');
    const acls = [
      { acltype: 'publishClientSend', topic: `${root}/#`, allow: true, priority: 10 },
      { acltype: 'subscribePattern', topic: `${root}/#`, allow: true, priority: 10 },
    ];
    const [role, me] = await dynsec([
      { command: 'createRole', rolename: BACKEND_ROLE, acls },
      { command: 'getClient', username: backendUser },
    ]);
    check([role!], ALREADY);
    check([me!]);
    const follow: DynsecCommand[] = [
      // An existing role keeps any extra ACLs an operator added; only missing ones are added.
      ...(isAlready(role!) ? acls.map((a) => ({ command: 'addRoleACL', rolename: BACKEND_ROLE, ...a })) : []),
      ...(rolesOf(clientOf(me!)).includes(BACKEND_ROLE) ? [] : [{ command: 'addClientRole', username: backendUser, rolename: BACKEND_ROLE, priority: 10 }]),
    ];
    if (follow.length) {
      try {
        check(await dynsec(follow), ALREADY);
      } catch (err) {
        // Changing the backend's own roles makes the broker disconnect it, so the answer
        // can be lost (first start on a fresh broker). Check the result once reconnected.
        if (!(err instanceof BrokerCredentialsError && err.retryable) || !(await reconnected())) throw err;
        const [again] = await dynsec([{ command: 'getClient', username: backendUser }]);
        check([again!]);
        if (!rolesOf(clientOf(again!)).includes(BACKEND_ROLE)) throw err;
      }
    }
    log().info('broker.dynsec.ready', { role: BACKEND_ROLE });
  },

  async issue(hardwareId, prefix) {
    assertDeviceAccount(hardwareId);
    const password = randomBytes(24).toString('base64url');
    const [role, created] = await dynsec(createDeviceCommands(hardwareId, prefix, password));
    check([role!], ALREADY);
    if (!created!.error) {
      if (isAlready(role!)) check(await dynsec([{ command: 'modifyRole', rolename: deviceRole(hardwareId), acls: deviceRoleAcls(prefix) }]));
      return { username: hardwareId, password };
    }
    check([created!], ALREADY);
    const [got] = await dynsec([{ command: 'getClient', username: hardwareId }]);
    check([got!]);
    check(await dynsec(updateDeviceCommands(hardwareId, prefix, password, { roleExisted: isAlready(role!), client: clientOf(got!) })));
    return { username: hardwareId, password };
  },

  async revoke(hardwareId) {
    assertDeviceAccount(hardwareId);
    // deleteClient also disconnects a connected client.
    check(await dynsec([{ command: 'deleteClient', username: hardwareId }, { command: 'deleteRole', rolename: deviceRole(hardwareId) }]), MISSING);
  },
};

export const brokerCredentials = {
  provider: (): BrokerCredentialProvider => (lmsConfig().credentialsMode === 'mosquitto-dynsec' ? dynsecProvider : sharedProvider),
};
