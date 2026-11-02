import { mqttConfig } from '../../config/mqtt.config';
import { ERROR_CODES } from '../../constants/error-codes.constants';
import { CAPABILITIES } from '../../constants/mqtt.constants';
import { deviceDao } from '../../dao/device.dao';
import { projectDao } from '../../dao/project.dao';
import { userDao } from '../../dao/user.dao';
import { variableDao } from '../../dao/variable.dao';
import type { LmsProgramRef } from '../../models/project.model';
import type { AuthUser } from '../../types/auth.types';
import { conflict, notFound, validationError } from '../../utils/error.util';
import { oid } from '../../utils/id.util';
import { traced } from '../../utils/logger.util';
import { defaultDevicePrefix } from '../../utils/mqtt-topic.util';
import { escapeRegex } from '../../validations/shared/common.validation';
import { refreshUserStreams } from '../public/device.service';
import { activityService } from '../shared/activity.service';
import { deviceRegistry } from '../shared/device-registry.service';
import { deviceSimulator } from '../shared/device-simulator.service';
import { toDeviceDTO } from '../shared/mappers';
import { auditLogService } from './audit-log.service';

/**
 * Registration of REAL (trusted) devices is an administrative action: an
 * admin assigns the hardware id, the topic namespace and the owner. Users
 * can never mark a device as real by themselves.
 */
const withOwner = (d: Parameters<typeof toDeviceDTO>[0]) => ({
  ...toDeviceDTO(d),
  ownerId: String(d.ownerId),
  connectionState: d.connectionState,
  lastSeenAt: d.lastSeenAt?.getTime() ?? null,
  registeredBy: d.registeredBy ? String(d.registeredBy) : null,
});

export const deviceManagementService = {
  list: (q: { q?: string; ownerId?: string; simulated?: boolean; status?: string; page: number; pageSize: number; sort: { field: string; direction: 1 | -1 } }) =>
    traced('DeviceManagementService.list', async () => {
      const r = await deviceDao.paginateAll({ q: q.q ? escapeRegex(q.q) : undefined, ownerId: q.ownerId, simulated: q.simulated, status: q.status }, q.page, q.pageSize, q.sort);
      return { ...r, items: r.items.map(withOwner) };
    }),

  register: (actor: AuthUser, input: { ownerId: string; name: string; hardwareId: string; board: string; firmwareVersion?: string; capabilities: string[]; topicPrefix?: string; lmsProgram: LmsProgramRef | null; reason?: string }) =>
    traced('DeviceManagementService.register', async () => {
      if (input.hardwareId.startsWith('sandbox-')) throw validationError('Hardware ids may not start with “sandbox-”.');
      const owner = await userDao.findById(input.ownerId);
      if (!owner) throw notFound('Owner');
      const prefix = input.topicPrefix ?? defaultDevicePrefix(mqttConfig().topicRoot, input.hardwareId);
      if (await deviceDao.existsHardwareOrPrefix(input.hardwareId, prefix)) throw conflict('A device with this hardware id or topic namespace already exists.', ERROR_CODES.DUPLICATE);
      const d = await deviceDao.create({
        ownerId: owner._id, name: input.name, hardwareId: input.hardwareId, topicPrefix: prefix, board: input.board,
        origin: input.lmsProgram ? 'lms' : 'studio', simulated: false, status: 'active', lmsProgram: input.lmsProgram, firmwareVersion: input.firmwareVersion,
        capabilities: input.capabilities.map((k) => ({ ...CAPABILITIES[k] })), registeredBy: oid(actor.id),
      });
      await deviceRegistry.reloadDevice(String(d._id));
      await refreshUserStreams(input.ownerId);
      await activityService.record({ ownerId: input.ownerId, deviceId: String(d._id), type: 'device.created', message: `${d.name} (${d.hardwareId}) registered by an administrator` });
      await auditLogService.record({ action: 'device.register', outcome: 'success', actor: { id: actor.id, role: actor.role }, target: { type: 'device', id: String(d._id) }, metadata: { hardwareId: d.hardwareId, ownerId: input.ownerId, topicPrefix: prefix, reason: input.reason } });
      return withOwner(d);
    }),

  /** Disable/enable, reassign owner, change namespace. Reassignment detaches the device from the old owner's projects. */
  update: (actor: AuthUser, id: string, patch: { name?: string; ownerId?: string; status?: 'active' | 'disabled'; topicPrefix?: string; firmwareVersion?: string; reason?: string }) =>
    traced('DeviceManagementService.update', async () => {
      const before = await deviceDao.findById(id);
      if (!before) throw notFound('Device');
      if (patch.topicPrefix && patch.topicPrefix !== before.topicPrefix && (await deviceDao.existsHardwareOrPrefix('\u0000', patch.topicPrefix, id))) {
        throw conflict('Another device already uses this topic namespace.', ERROR_CODES.DUPLICATE);
      }
      let newOwner = null;
      if (patch.ownerId && patch.ownerId !== String(before.ownerId)) {
        newOwner = await userDao.findById(patch.ownerId);
        if (!newOwner) throw notFound('Owner');
      }
      const { reason, ownerId, ...rest } = patch;
      const updated = await deviceDao.adminUpdate(id, { ...rest, ...(newOwner ? { ownerId: newOwner._id } : {}) });
      if (newOwner) {
        await projectDao.pullDeviceForOwner(String(before.ownerId), id);
        await variableDao.clearDevice(id);
        await refreshUserStreams(String(before.ownerId));
        await refreshUserStreams(String(newOwner._id));
      }
      if (patch.status === 'disabled' && before.simulated) deviceSimulator.forget(id);
      await deviceRegistry.reloadDevice(id);
      await auditLogService.record({
        action: 'device.admin.update', outcome: 'success', actor: { id: actor.id, role: actor.role }, target: { type: 'device', id },
        metadata: { changes: Object.keys(rest).concat(newOwner ? ['ownerId'] : []), fromOwner: newOwner ? String(before.ownerId) : undefined, toOwner: ownerId, reason },
      });
      return withOwner(updated!);
    }),

  remove: (actor: AuthUser, id: string) =>
    traced('DeviceManagementService.remove', async () => {
      const d = await deviceDao.findById(id);
      if (!d) throw notFound('Device');
      await projectDao.pullDeviceForOwner(String(d.ownerId), id);
      await variableDao.clearDevice(id);
      await deviceDao.deleteById(id);
      deviceSimulator.forget(id);
      deviceRegistry.removeDevice(id);
      await refreshUserStreams(String(d.ownerId));
      await auditLogService.record({ action: 'device.admin.delete', outcome: 'success', actor: { id: actor.id, role: actor.role }, target: { type: 'device', id }, metadata: { hardwareId: d.hardwareId, ownerId: String(d.ownerId) } });
      return { id };
    }),
};
