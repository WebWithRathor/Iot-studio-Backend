import { Types } from 'mongoose';
import { loadEnv } from '../../config/env.config';
import { lmsConfig } from '../../config/lms.config';
import { mqttConfig } from '../../config/mqtt.config';
import { LIMITS } from '../../constants/app.constants';
import { ERROR_CODES } from '../../constants/error-codes.constants';
import { deviceDao } from '../../dao/device.dao';
import { projectDao } from '../../dao/project.dao';
import { userDao } from '../../dao/user.dao';
import { variableDao } from '../../dao/variable.dao';
import type { CapabilityDoc, DeviceDoc } from '../../models/device.model';
import type { LmsProgramRef, ProjectDoc } from '../../models/project.model';
import { AppError } from '../../utils/error.util';
import { LmsApiError } from '../../utils/lms-api-error.util';
import { chipInUseDetails, decideChipBinding } from '../../utils/lms-chip.util';
import { oid } from '../../utils/id.util';
import { channel, traced } from '../../utils/logger.util';
import { defaultDevicePrefix, suggestTopics } from '../../utils/mqtt-topic.util';
import type { LmsUpsertDeviceInput, LmsVariableInput } from '../../validations/integrations/lms.validation';
import { auditLogService } from '../private/audit-log.service';
import { refreshUserStreams } from '../public/device.service';
import { projectService } from '../public/project.service';
import { activityService } from '../shared/activity.service';
import { brokerCredentials, type DeviceCredentials } from '../shared/broker-credentials.service';
import { deviceRegistry } from '../shared/device-registry.service';
import { LmsIdentityError, lmsIdentityService } from '../shared/lms-identity.service';
import { mqttConnection } from '../shared/mqtt-connection.service';
import { realtimeService } from '../shared/realtime.service';

/**
 * LMS → IoT Studio device API (contract B, docs/LMS-INTEGRATION.md).
 * A board flashed from the LMS becomes a REAL device (origin "lms"), owned by
 * the student, with the variables its blocks declared; optionally a project
 * for the program is created/updated with one variable per declaration.
 */

export type LmsWarning = 'insufficient_tokens_project_not_created' | 'project_limit_reached_project_not_created' | 'variable_limit_reached';

export interface LmsDeviceResponse {
  deviceId: string;
  hardwareId: string;
  topicPrefix: string;
  broker: { url: string; host: string; port: number; tls: boolean };
  credentials: DeviceCredentials | null;
  projectId: string | null;
  studioUrl: string;
  warnings: LmsWarning[];
}

export interface LmsDeviceStatus {
  deviceId: string;
  hardwareId: string;
  ownerLmsUserId: string | null;
  connectionState: string;
  lastSeenAt: number | null;
  /** Bound chip (machine.unique_id() hex), null if the LMS never sent one. */
  chipId: string | null;
  projectIds: string[];
  studioUrl: string;
}

export interface LmsBulkStatus {
  devices: Omit<LmsDeviceStatus, 'chipId' | 'projectIds'>[];
  /** Requested ids that are unknown or not LMS devices. */
  missing: string[];
}

const log = () => channel('app');

const studioUrl = (deviceId: string) => `${loadEnv().FRONTEND_URL.replace(/\/+$/, '')}/#/devices/${deviceId}`;

function assertEnabled() {
  const c = lmsConfig();
  if (!c.enabled || !c.publicBroker) throw new LmsApiError(503, 'integration_disabled', 'The LMS integration is turned off on this IoT Studio server.');
  return c;
}

const toCapability = (v: LmsVariableInput): CapabilityDoc => ({
  key: v.key,
  displayName: v.displayName,
  dataType: v.dataType,
  direction: v.direction,
  ...(v.unit ? { unit: v.unit } : {}),
  ...(v.min !== undefined ? { min: v.min } : {}),
  ...(v.max !== undefined ? { max: v.max } : {}),
});

async function resolveOwner(input: LmsUpsertDeviceInput['user'], ip?: string) {
  try {
    return (await lmsIdentityService.resolveUser({ lmsUserId: input.lmsUserId, email: input.email, emailVerified: input.emailVerified, name: input.name }, ip)).user;
  } catch (err) {
    if (err instanceof LmsIdentityError) {
      if (err.problem === 'disabled') throw new LmsApiError(403, 'user_disabled', err.message);
      throw new LmsApiError(422, 'validation_failed', err.message, { fieldErrors: { 'user.email': 'Already used by another IoT Studio account (verify the email in the LMS, or ask an IoT Studio admin).' } });
    }
    throw err;
  }
}

/**
 * Project for the program: reuse the student's project linked to this
 * programId, else create one (normal token costs). Then upsert one variable
 * per declaration with firmwareRef, and flag the ones no longer declared.
 */
async function syncProject(userId: string, device: DeviceDoc, program: LmsProgramRef, variables: LmsVariableInput[], warnings: LmsWarning[]): Promise<string | null> {
  const deviceId = String(device._id);
  let project: ProjectDoc | null = await projectDao.findOwnedByLmsProgram(userId, program.programId);
  if (!project) {
    try {
      const created = await projectService.create(userId, {
        name: program.name.slice(0, 60),
        description: `Created from the Kokoon LMS program “${program.name}”${program.version ? ` (${program.version})` : ''}.`,
        category: 'Custom',
        icon: 'LuGraduationCap',
        accent: 'indigo',
        deviceIds: [deviceId],
        lmsProgram: program,
        importVariables: false,
      });
      project = await projectDao.findOwned(created.project.id, userId);
    } catch (err) {
      if (err instanceof AppError && err.code === ERROR_CODES.INSUFFICIENT_TOKENS) {
        warnings.push('insufficient_tokens_project_not_created');
        return null;
      }
      if (err instanceof AppError && err.code === ERROR_CODES.LIMIT_REACHED) {
        warnings.push('project_limit_reached_project_not_created');
        return null;
      }
      throw err;
    }
    if (!project) return null;
  } else {
    if (!project.deviceIds.some((d) => String(d) === deviceId)) {
      await projectDao.addDevice(String(project._id), userId, deviceId);
      await activityService.record({ ownerId: userId, projectId: String(project._id), deviceId, type: 'device.associated', message: `${device.name} associated with ${project.name} (flashed from the LMS)` });
    }
    const p = project.lmsProgram;
    if (!p || p.name !== program.name || p.version !== program.version) await projectDao.updateOwned(String(project._id), userId, { lmsProgram: program });
  }

  const projectId = String(project._id);
  const existing = await variableDao.listByProject(projectId, userId);
  let count = existing.length;
  let added = 0;
  let updated = 0;
  const taken = new Set(existing.map((v) => v.key));
  for (const v of variables) {
    const topics = suggestTopics(device.topicPrefix, v.key, v.direction);
    const firmwareRef = { source: 'lms' as const, blockId: v.blockId, variableName: v.key, declared: true };
    const fields = {
      displayName: v.displayName, dataType: v.dataType, direction: v.direction, deviceId: device._id,
      stateTopic: topics.stateTopic, commandTopic: topics.commandTopic, unit: v.unit, min: v.min, max: v.max, firmwareRef,
    };
    const match =
      existing.find((x) => String(x.deviceId) === deviceId && x.firmwareRef?.variableName === v.key) ??
      existing.find((x) => String(x.deviceId) === deviceId && !x.firmwareRef && x.key === v.key);
    if (match) {
      await variableDao.updateFromFirmware(String(match._id), userId, fields);
      updated++;
      continue;
    }
    if (count >= LIMITS.MAX_VARIABLES_PER_PROJECT) {
      if (!warnings.includes('variable_limit_reached')) warnings.push('variable_limit_reached');
      continue;
    }
    let key = v.key;
    for (let n = 2; taken.has(key); n++) key = `${v.key}_${n}`.slice(0, 40);
    taken.add(key);
    await variableDao.create({ _id: new Types.ObjectId(), projectId: project._id, ownerId: oid(userId), key, ...fields });
    count++;
    added++;
  }
  await variableDao.markUndeclared(projectId, deviceId, variables.map((v) => v.key));
  if (added || updated) {
    await activityService.record({ ownerId: userId, projectId, deviceId, type: 'variable.created', message: `${device.name}: ${added} variable(s) added and ${updated} updated from the LMS program “${program.name}”` });
  }
  // Every variable written here belongs to this device: the caller reloads it in the registry.
  return projectId;
}

/** 422 when one more ACTIVE device would exceed the per-account cap (new board, or re-enabling one after B3). */
async function assertDeviceCap(userId: string): Promise<void> {
  if ((await deviceDao.countActiveOwned(userId)) >= LIMITS.MAX_DEVICES_PER_USER) throw new LmsApiError(422, 'validation_failed', `An account can have at most ${LIMITS.MAX_DEVICES_PER_USER} devices.`);
}

/** 409 chip_in_use if another ACTIVE device is bound to this chip. */
async function chipInUseError(chipId: string, deviceId: string | undefined, userId: string): Promise<LmsApiError | null> {
  const other = await deviceDao.findActiveByChip(chipId, deviceId);
  if (!other) return null;
  return new LmsApiError(409, 'chip_in_use', 'This ESP32 is already registered as another board. Use that board in the LMS, or remove it there first.', chipInUseDetails(other, userId));
}

/** Map a unique-index race (E11000) on B1 to a contract error; anything else is rethrown as is. */
async function duplicateKeyError(err: unknown, hardwareId: string, chipId: string | undefined, deviceId: string | undefined, userId: string): Promise<unknown> {
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  if (e?.code !== 11000) return err;
  if (e.keyPattern && 'chipId' in e.keyPattern && chipId) {
    return (await chipInUseError(chipId, deviceId, userId)) ?? new LmsApiError(503, 'request_in_progress', 'This ESP32 is being registered by a parallel request. Retry shortly.');
  }
  // A parallel request for the same board won the unique index: the same student retrying is not "another account".
  const winner = await deviceDao.findByHardwareId(hardwareId);
  if (winner && String(winner.ownerId) === userId) return new LmsApiError(503, 'request_in_progress', 'This board is being registered by a parallel request. Retry shortly.');
  return new LmsApiError(409, 'device_owned_by_other_user', 'This hardware id or its topic namespace is already registered.');
}

/**
 * Clear {prefix}/availability (empty retained message): a board disconnected by
 * the broker (B3 revoke, chip replace) sends no Last Will, so its retained
 * "online" would otherwise linger. Best effort; the backend role may publish there.
 */
async function clearRetainedAvailability(device: DeviceDoc): Promise<void> {
  if (!mqttConnection.isConnected()) return;
  try {
    await mqttConnection.publish(`${device.topicPrefix}/availability`, '', { qos: 1, retain: true });
  } catch (err) {
    log().warn('lms.device.availability.clear.failed', { deviceId: String(device._id), errorName: (err as Error).name });
  }
}

/**
 * The broker just cut this board's old login off (new password: LMS "Reset connection",
 * chip replace, re-enable, retry) and refuses it from now on. It sent no Last Will, so
 * nothing else will say the board went offline: mark it disconnected here (dashboards,
 * LMS status) and clear its retained "online". A board that never connected stays "waiting".
 */
async function markOldLoginCut(device: DeviceDoc): Promise<void> {
  const deviceId = String(device._id);
  if (deviceRegistry.runtimeOf(deviceId)?.state !== 'waiting' && deviceRegistry.setState(deviceId, 'disconnected')) {
    realtimeService.toDevice(deviceId, { type: 'device', data: { deviceId, runtime: deviceRegistry.runtimeOf(deviceId)! } });
    await activityService.record({ ownerId: String(device.ownerId), deviceId, type: 'device.disconnected', message: `${device.name} disconnected — it got a new broker login, so upload the program again to reconnect` });
  }
  await clearRetainedAvailability(device);
}

/** B2 / bulk status fields; runtime state from the registry, else the stored state. */
function statusOf(device: DeviceDoc, ownerLmsUserId: string | null) {
  const deviceId = String(device._id);
  const runtime = deviceRegistry.runtimeOf(deviceId);
  return {
    deviceId,
    hardwareId: device.hardwareId,
    ownerLmsUserId,
    connectionState: device.status === 'disabled' ? 'disabled' : runtime?.state ?? device.connectionState,
    lastSeenAt: runtime?.lastSeen ?? device.lastSeenAt?.getTime() ?? null,
    studioUrl: studioUrl(deviceId),
  };
}

export const lmsIntegrationService = {
  /** B1 — PUT /integrations/lms/devices/{hardwareId} */
  upsertDevice: (hardwareId: string, input: LmsUpsertDeviceInput, opts: { rotateCredentials: boolean; replaceChip?: boolean; ip?: string }) =>
    traced('LmsIntegrationService.upsertDevice', async (): Promise<{ created: boolean; body: LmsDeviceResponse }> => {
      const cfg = assertEnabled();
      const owner = await resolveOwner(input.user, opts.ip);
      const userId = String(owner._id);
      const program: LmsProgramRef = { programId: input.program.programId, name: input.program.name, ...(input.program.version ? { version: input.program.version } : {}), source: 'lms' };
      const capabilities = input.variables.map(toCapability);
      const chipId = input.device.chipId;

      let device = await deviceDao.findByHardwareId(hardwareId);
      if (device && String(device.ownerId) !== userId) {
        throw new LmsApiError(409, 'device_owned_by_other_user', 'This hardware id is registered to another IoT Studio account.');
      }
      if (device?.simulated) throw new LmsApiError(422, 'validation_failed', 'This hardware id belongs to a simulated device.', { fieldErrors: { hardwareId: 'Reserved by a simulated device.' } });

      const chip = decideChipBinding(device?.chipId, chipId, opts.replaceChip ?? false);
      if (chip === 'mismatch') {
        throw new LmsApiError(409, 'chip_mismatch', 'This board record is already bound to a different ESP32. Send replaceChip=true to move it to this chip (the old chip loses broker access).');
      }
      if (chip !== 'keep') {
        const inUse = await chipInUseError(chipId!, device ? String(device._id) : undefined, userId);
        if (inUse) throw inUse;
      }

      const created = !device;
      const wasDisabled = device?.status === 'disabled';
      const rotated = opts.rotateCredentials || chip === 'replace';
      if (!device) {
        const prefix = defaultDevicePrefix(mqttConfig().topicRoot, hardwareId);
        await assertDeviceCap(userId);
        if (await deviceDao.existsHardwareOrPrefix(hardwareId, prefix)) throw new LmsApiError(409, 'device_owned_by_other_user', 'This hardware id or its topic namespace is already registered.');
        try {
          device = await deviceDao.create({
            ownerId: owner._id, name: input.device.name, hardwareId, topicPrefix: prefix, board: input.device.board, origin: 'lms', simulated: false, status: 'active',
            lmsProgram: program, firmwareVersion: input.device.firmwareVersion, capabilities, registeredBy: null, ...(chipId ? { chipId } : {}), credentialsIssuedAt: null,
          });
        } catch (err) {
          throw await duplicateKeyError(err, hardwareId, chipId, undefined, userId);
        }
      } else {
        const existingId = String(device._id);
        const chipToStore = chip === 'keep' ? undefined : chipId;
        // A disabled board is not counted, so re-enabling it must pass the cap like a new one.
        if (wasDisabled) await assertDeviceCap(userId);
        try {
          device = (await deviceDao.lmsSync(existingId, {
            name: input.device.name, board: input.device.board, firmwareVersion: input.device.firmwareVersion, lmsProgram: program, capabilities, status: 'active', origin: 'lms',
            chipId: chipToStore, credentialsOwed: wasDisabled || rotated,
          }))!;
        } catch (err) {
          // Re-enabling a board whose chip is now another active board's.
          throw await duplicateKeyError(err, hardwareId, chipToStore ?? device.chipId ?? undefined, existingId, userId);
        }
      }
      const deviceId = String(device._id);

      // Credentials are owed (credentialsIssuedAt null) when the device is new, re-enabled after B3,
      // rotated (also by a chip replace), or an earlier attempt failed before they were issued.
      // The flag is set only as the LAST step, after everything else that can fail: a failed request's
      // retry issues them again (the first password was never delivered), so it never answers credentials:null.
      let credentials: DeviceCredentials | null = null;
      const provider = brokerCredentials.provider();
      // A new password for an existing broker account disconnects the board using the old one, without its
      // Last Will. Marked right away, before anything below can fail. (The shared dev account keeps working.)
      const cutsOldLogin = !created && provider.mode === 'mosquitto-dynsec';
      if (device.credentialsIssuedAt === null) {
        try {
          credentials = await provider.issue(hardwareId, device.topicPrefix);
        } catch (err) {
          log().error('lms.device.credentials.failed', { deviceId, hardwareId, mode: provider.mode, errorName: (err as Error).name, error: (err as Error).message });
          // The broker may have changed the password anyway (answer lost, a later command failing). If it did not,
          // the board's next telemetry marks it connected again; a stale "connected" would never correct itself.
          if (cutsOldLogin) await markOldLoginCut(device).catch((e: unknown) => log().warn('lms.device.presence.failed', { deviceId, errorName: (e as Error).name }));
          throw new LmsApiError(503, 'unavailable', 'The board was saved but its broker account could not be set up right now. Retry the same request; the retry issues the credentials.');
        }
        if (cutsOldLogin && !wasDisabled) await markOldLoginCut(device); // a re-enabled board is not in the registry yet: below
      }

      await refreshUserStreams(userId);
      await activityService.record({
        ownerId: userId, deviceId, type: created ? 'device.created' : 'device.associated',
        message: created ? `${device.name} (${hardwareId}) flashed from the LMS program “${program.name}”` : `${device.name} re-flashed from the LMS program “${program.name}”${program.version ? ` ${program.version}` : ''}`,
      });

      const warnings: LmsWarning[] = [];
      const projectId = input.project.create ? await syncProject(userId, device, program, input.variables, warnings) : null;

      // This one device and its (just synced) variables, not a full reload of every device: B1 comes in classroom bursts.
      await deviceRegistry.reloadDevice(deviceId);
      // A re-enabled board only re-entered the registry just now, with the state stored before B3 cut it off.
      if (credentials && cutsOldLogin && wasDisabled) await markOldLoginCut(device);

      await auditLogService.record({
        action: 'lms.device.upserted', outcome: 'success', actor: { id: userId, role: owner.role }, target: { type: 'device', id: deviceId }, ip: opts.ip,
        metadata: { hardwareId, created, programId: program.programId, variables: input.variables.length, projectId, warnings },
      });
      if (credentials) {
        await deviceDao.markCredentialsIssued(deviceId, new Date());
        const reason = created ? 'created' : wasDisabled ? 'reenabled' : chip === 'replace' ? 'chip_replaced' : rotated ? 'rotated' : 'retried';
        await auditLogService.record({ action: 'lms.device.credentials', outcome: 'success', actor: { id: userId, role: owner.role }, target: { type: 'device', id: deviceId }, ip: opts.ip, metadata: { hardwareId, reason, mode: provider.mode } });
      }
      log().info('lms.device.upserted', { deviceId, hardwareId, created, projectId, warnings });
      return {
        created,
        body: { deviceId, hardwareId, topicPrefix: device.topicPrefix, broker: cfg.publicBroker!, credentials, projectId, studioUrl: studioUrl(deviceId), warnings },
      };
    }),

  /** B2 — GET /integrations/lms/devices/{hardwareId} */
  getDevice: (hardwareId: string) =>
    traced('LmsIntegrationService.getDevice', async (): Promise<LmsDeviceStatus> => {
      assertEnabled();
      const device = await deviceDao.findByHardwareId(hardwareId);
      if (!device || device.origin !== 'lms') throw new LmsApiError(404, 'not_found', 'No LMS device with this hardware id.');
      const deviceId = String(device._id);
      const [owner, projectIds] = await Promise.all([userDao.findById(String(device.ownerId)), projectDao.listIdsWithDevice(String(device.ownerId), deviceId)]);
      const { studioUrl: url, ...status } = statusOf(device, owner?.lmsUserId ?? null);
      return { ...status, chipId: device.chipId ?? null, projectIds, studioUrl: url };
    }),

  /** Bulk B2 — POST /integrations/lms/devices/status: one devices query, one owners query. Read-only. */
  devicesStatus: (hardwareIds: string[]) =>
    traced('LmsIntegrationService.devicesStatus', async (): Promise<LmsBulkStatus> => {
      assertEnabled();
      const wanted = [...new Set(hardwareIds)];
      const found = new Map((await deviceDao.findByHardwareIds(wanted)).filter((d) => d.origin === 'lms').map((d) => [d.hardwareId, d]));
      const ownerIds = [...new Set([...found.values()].map((d) => String(d.ownerId)))];
      const lmsIds = new Map(ownerIds.length ? (await userDao.findLmsIds(ownerIds)).map((u) => [String(u._id), u.lmsUserId ?? null]) : []);
      const devices: LmsBulkStatus['devices'] = [];
      const missing: string[] = [];
      for (const h of wanted) {
        const d = found.get(h);
        if (d) devices.push(statusOf(d, lmsIds.get(String(d.ownerId)) ?? null));
        else missing.push(h);
      }
      return { devices, missing };
    }),

  /** B3 — DELETE /integrations/lms/devices/{hardwareId}: disable + revoke credentials. Idempotent. */
  disableDevice: (hardwareId: string, ip?: string) =>
    traced('LmsIntegrationService.disableDevice', async (): Promise<void> => {
      assertEnabled();
      const device = await deviceDao.findByHardwareId(hardwareId);
      if (!device || device.origin !== 'lms') throw new LmsApiError(404, 'not_found', 'No LMS device with this hardware id.');
      const deviceId = String(device._id);
      const ownerId = String(device.ownerId);
      try {
        await brokerCredentials.provider().revoke(hardwareId);
      } catch (err) {
        log().error('lms.device.revoke.failed', { deviceId, hardwareId, errorName: (err as Error).name, error: (err as Error).message });
        throw new LmsApiError(503, 'unavailable', 'The board’s broker access could not be revoked right now. Retry the same request.');
      }
      if (device.status !== 'disabled' || device.credentialsIssuedAt !== null) await deviceDao.lmsDisable(deviceId);
      if (device.status !== 'disabled') {
        deviceRegistry.removeDevice(deviceId);
        await refreshUserStreams(ownerId);
        await activityService.record({ ownerId, deviceId, type: 'device.disconnected', message: `${device.name} was removed in the LMS — its broker access is revoked` });
      }
      // After the device left the registry, so the backend's own ingest drops the clearing message.
      await clearRetainedAvailability(device);
      await auditLogService.record({ action: 'lms.device.disabled', outcome: 'success', actor: { id: ownerId }, target: { type: 'device', id: deviceId }, ip, metadata: { hardwareId } });
    }),
};
