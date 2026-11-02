import { Types } from 'mongoose';
import { mqttConfig } from '../../config/mqtt.config';
import { LIMITS, type DataType, type Direction } from '../../constants/app.constants';
import { ERROR_CODES } from '../../constants/error-codes.constants';
import { dashboardDao } from '../../dao/dashboard.dao';
import { deviceDao } from '../../dao/device.dao';
import { projectDao } from '../../dao/project.dao';
import { variableDao } from '../../dao/variable.dao';
import type { DeviceDoc } from '../../models/device.model';
import type { VariableDTO } from '../../types/project.types';
import { AppError, conflict, limitReached, notFound, validationError } from '../../utils/error.util';
import { oid } from '../../utils/id.util';
import { traced } from '../../utils/logger.util';
import { isUnderPrefix, suggestTopics } from '../../utils/mqtt-topic.util';
import { withTransaction } from '../../database/mongo.transactions';
import { activityService } from '../shared/activity.service';
import { deviceRegistry } from '../shared/device-registry.service';
import { toVariableDTO } from '../shared/mappers';

export interface VariableInput {
  key: string;
  displayName: string;
  dataType: DataType;
  direction: Direction;
  deviceId: string | null;
  stateTopic?: string;
  commandTopic?: string;
  unit?: string;
  min?: number;
  max?: number;
}

/** Topic namespace for variables that are not linked to a device. Nothing routes there, so nothing can be spoofed. */
export const sandboxPrefix = (userId: string) => `${mqttConfig().topicRoot}/sandbox-${userId}`;

/**
 * TOPIC POLICY — a variable's topics must live inside the namespace of the
 * device it is linked to (the device's topicPrefix, assigned by the server),
 * or inside the user's sandbox when it has no device. A browser can therefore
 * never point a variable at another user's device topics.
 */
export function assertTopicsAllowed(userId: string, device: Pick<DeviceDoc, 'topicPrefix' | 'name'> | null, topics: { stateTopic?: string; commandTopic?: string }): void {
  const prefix = device ? device.topicPrefix : sandboxPrefix(userId);
  const fieldErrors: Record<string, string> = {};
  for (const k of ['stateTopic', 'commandTopic'] as const) {
    const t = topics[k];
    if (t && !isUnderPrefix(t, prefix)) fieldErrors[k] = device ? `Must start with ${prefix}/ (the namespace of ${device.name}).` : `Variables without a device must use ${prefix}/…`;
  }
  if (Object.keys(fieldErrors).length) throw new AppError(400, ERROR_CODES.TOPIC_NOT_ALLOWED, 'A topic is outside the allowed namespace.', { fieldErrors });
}

async function resolveDevice(userId: string, projectDeviceIds: string[], deviceId: string | null): Promise<DeviceDoc | null> {
  if (!deviceId) return null;
  if (!projectDeviceIds.includes(deviceId)) throw validationError('The device is not part of this project.', { fieldErrors: { deviceId: 'Associate the device with this project first.' } });
  const d = await deviceDao.findOwned(deviceId, userId);
  if (!d) throw notFound('Device');
  return d;
}

const dupKey = (key: string) => conflict(`“${key}” is already used in this project. Identifiers must be unique.`, ERROR_CODES.DUPLICATE, { fieldErrors: { key: `“${key}” is already used in this project.` } });

export const variableService = {
  list: (userId: string, projectId: string) =>
    traced('VariableService.list', async (): Promise<VariableDTO[]> => {
      if (!(await projectDao.findOwned(projectId, userId))) throw notFound('Project');
      return (await variableDao.listByProject(projectId, userId)).map(toVariableDTO);
    }),

  create: (userId: string, projectId: string, input: VariableInput) =>
    traced('VariableService.create', async (): Promise<VariableDTO> => {
      const project = await projectDao.findOwned(projectId, userId);
      if (!project) throw notFound('Project');
      if ((await variableDao.countByProject(projectId)) >= LIMITS.MAX_VARIABLES_PER_PROJECT) throw limitReached(`A project can have at most ${LIMITS.MAX_VARIABLES_PER_PROJECT} variables.`);
      const device = await resolveDevice(userId, project.deviceIds.map(String), input.deviceId);
      assertTopicsAllowed(userId, device, input);
      if (await variableDao.keyExists(projectId, input.key)) throw dupKey(input.key);
      const v = await variableDao.create({
        projectId: project._id, ownerId: oid(userId), key: input.key, displayName: input.displayName, dataType: input.dataType, direction: input.direction,
        deviceId: device ? device._id : null, stateTopic: input.direction === 'command' ? undefined : input.stateTopic, commandTopic: input.direction === 'telemetry' ? undefined : input.commandTopic,
        unit: input.unit, min: input.min, max: input.max, firmwareRef: null,
      }).catch((err) => {
        if ((err as { code?: number }).code === 11000) throw dupKey(input.key);
        throw err;
      });
      deviceRegistry.invalidate();
      await activityService.record({ ownerId: userId, projectId, type: 'variable.created', message: `Variable ${v.key} created` });
      return toVariableDTO(v);
    }),

  update: (userId: string, id: string, input: VariableInput) =>
    traced('VariableService.update', async (): Promise<VariableDTO> => {
      const existing = await variableDao.findOwned(id, userId);
      if (!existing) throw notFound('Variable');
      const project = await projectDao.findOwned(String(existing.projectId), userId);
      if (!project) throw notFound('Project');
      const device = await resolveDevice(userId, project.deviceIds.map(String), input.deviceId);
      assertTopicsAllowed(userId, device, input);
      if (input.key !== existing.key && (await variableDao.keyExists(String(existing.projectId), input.key, id))) throw dupKey(input.key);
      const updated = await variableDao.update(id, userId, {
        key: input.key, displayName: input.displayName, dataType: input.dataType, direction: input.direction, deviceId: device ? device._id : null,
        stateTopic: input.direction === 'command' ? undefined : input.stateTopic, commandTopic: input.direction === 'telemetry' ? undefined : input.commandTopic,
        unit: input.unit, min: input.min, max: input.max,
      });
      if (!updated) throw notFound('Variable');
      deviceRegistry.invalidate();
      await activityService.record({ ownerId: userId, projectId: String(existing.projectId), type: 'variable.updated', message: `Variable ${updated.key} updated` });
      return toVariableDTO(updated);
    }),

  /** Deleting a variable unbinds every widget that used it (in one transaction when available). */
  remove: (userId: string, id: string) =>
    traced('VariableService.remove', async (): Promise<{ id: string; projectId: string }> => {
      const v = await variableDao.findOwned(id, userId);
      if (!v) throw notFound('Variable');
      await withTransaction('variable.delete', async (session) => {
        await dashboardDao.unbindVariable(String(v.projectId), id, session);
        await variableDao.deleteOwned(id, userId, session);
      });
      deviceRegistry.invalidate();
      await activityService.record({ ownerId: userId, projectId: String(v.projectId), type: 'variable.deleted', message: `Variable ${v.key} deleted (widgets using it are now unbound)` });
      return { id, projectId: String(v.projectId) };
    }),

  /** Add a variable declared by a device's firmware. Returns the existing one when already present. */
  importFromDevice: (userId: string, projectId: string, deviceId: string, key: string) =>
    traced('VariableService.importFromDevice', async (): Promise<VariableDTO> => {
      const project = await projectDao.findOwned(projectId, userId);
      if (!project) throw notFound('Project');
      const device = await resolveDevice(userId, project.deviceIds.map(String), deviceId);
      const cap = device!.capabilities.find((c) => c.key === key);
      if (!cap) throw notFound('Device variable');
      const existing = (await variableDao.listByProject(projectId, userId)).find((v) => String(v.deviceId) === deviceId && v.key === key);
      if (existing) return toVariableDTO(existing);
      let finalKey = key;
      for (let n = 2; await variableDao.keyExists(projectId, finalKey); n++) finalKey = `${key}_${n}`;
      const v = await variableDao.create({
        projectId: project._id, ownerId: oid(userId), key: finalKey, displayName: cap.displayName, dataType: cap.dataType, direction: cap.direction,
        deviceId: device!._id, ...suggestTopics(device!.topicPrefix, cap.key, cap.direction), unit: cap.unit, min: cap.min, max: cap.max, firmwareRef: null,
      });
      deviceRegistry.invalidate();
      await activityService.record({ ownerId: userId, projectId, deviceId, type: 'variable.created', message: `Variable ${finalKey} added from ${device!.name}` });
      return toVariableDTO(v);
    }),

  /** Variables for a list of a device's declared capabilities (used when creating a project). */
  fromDeviceCapabilities(userId: string, projectId: Types.ObjectId, devices: DeviceDoc[]) {
    const seen = new Set<string>();
    const docs = [];
    for (const d of devices) {
      for (const c of d.capabilities) {
        if (seen.has(c.key)) continue;
        seen.add(c.key);
        docs.push({
          _id: new Types.ObjectId(), projectId, ownerId: oid(userId), key: c.key, displayName: c.displayName, dataType: c.dataType, direction: c.direction,
          deviceId: d._id, ...suggestTopics(d.topicPrefix, c.key, c.direction), unit: c.unit, min: c.min, max: c.max, firmwareRef: null,
        });
      }
    }
    return docs;
  },
};
