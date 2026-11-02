import { randomBytes } from 'node:crypto';
import { mqttConfig } from '../../config/mqtt.config';
import { LIMITS } from '../../constants/app.constants';
import { CAPABILITIES, DEVICE_KITS, type SimMode } from '../../constants/mqtt.constants';
import { deviceDao } from '../../dao/device.dao';
import { projectDao } from '../../dao/project.dao';
import type { DeviceDTO } from '../../types/project.types';
import type { DeviceRuntimeDTO } from '../../types/mqtt.types';
import { limitReached, notFound, unsupported } from '../../utils/error.util';
import { oid } from '../../utils/id.util';
import { traced } from '../../utils/logger.util';
import { defaultDevicePrefix } from '../../utils/mqtt-topic.util';
import { activityService } from '../shared/activity.service';
import { deviceRegistry } from '../shared/device-registry.service';
import { deviceSimulator } from '../shared/device-simulator.service';
import { toDeviceDTO } from '../shared/mappers';
import { realtimeService } from '../shared/realtime.service';

/** After ownership changes, tell the user's open SSE streams which devices they may receive. */
export async function refreshUserStreams(userId: string): Promise<void> {
  const ids = (await deviceDao.listOwned(userId)).map((d) => String(d._id));
  realtimeService.setUserDevices(userId, ids);
}

export const deviceService = {
  list: (userId: string) => traced('DeviceService.list', async (): Promise<DeviceDTO[]> => (await deviceDao.listOwned(userId)).map(toDeviceDTO)),

  get: (userId: string, id: string) =>
    traced('DeviceService.get', async (): Promise<{ device: DeviceDTO; runtime: DeviceRuntimeDTO | null }> => {
      const d = await deviceDao.findOwned(id, userId);
      if (!d) throw notFound('Device');
      return { device: toDeviceDTO(d), runtime: deviceRegistry.runtimeOf(id) };
    }),

  /**
   * Users may only create SIMULATED devices. The server picks the hardware id
   * and topic namespace; real devices are registered by an administrator.
   */
  createSimulated: (userId: string, input: { name: string; board: string; kit: string; projectIds: string[] }) =>
    traced('DeviceService.createSimulated', async (): Promise<{ device: DeviceDTO; projectIds: string[] }> => {
      if ((await deviceDao.countOwned(userId)) >= LIMITS.MAX_DEVICES_PER_USER) throw limitReached(`You can have at most ${LIMITS.MAX_DEVICES_PER_USER} devices.`);
      const kit = DEVICE_KITS[input.kit];
      const root = mqttConfig().topicRoot;
      let hw = '';
      for (let i = 0; i < 6 && !hw; i++) {
        const cand = `esp32-sim-${randomBytes(3).toString('hex')}`;
        if (!(await deviceDao.existsHardwareOrPrefix(cand, defaultDevicePrefix(root, cand)))) hw = cand;
      }
      if (!hw) throw new Error('Could not allocate a hardware id');
      const device = await deviceDao.create({
        ownerId: oid(userId), name: input.name, hardwareId: hw, topicPrefix: defaultDevicePrefix(root, hw), board: input.board,
        origin: 'studio', simulated: true, status: 'active', lmsProgram: null, firmwareVersion: 'sim-1.0.0',
        capabilities: kit.caps.map((k) => ({ ...CAPABILITIES[k] })), registeredBy: null,
      });
      const id = String(device._id);
      const associated: string[] = [];
      for (const pid of input.projectIds) {
        const p = await projectDao.addDevice(pid, userId, id);
        if (p) {
          associated.push(pid);
          await activityService.record({ ownerId: userId, projectId: pid, deviceId: id, type: 'device.associated', message: `${device.name} associated` });
        }
      }
      await activityService.record({ ownerId: userId, deviceId: id, type: 'device.created', message: `Simulated device ${device.name} (${hw}) registered` });
      await deviceRegistry.reloadDevice(id);
      await refreshUserStreams(userId);
      return { device: toDeviceDTO(device), projectIds: associated };
    }),

  rename: (userId: string, id: string, name: string) =>
    traced('DeviceService.rename', async (): Promise<DeviceDTO> => {
      const d = await deviceDao.rename(id, userId, name);
      if (!d) throw notFound('Device');
      deviceRegistry.invalidate();
      return toDeviceDTO(d);
    }),

  /** Demo controls (disconnect, error, rejected credentials, reconnect) — simulated devices only. */
  setSimulationMode: (userId: string, id: string, mode: SimMode) =>
    traced('DeviceService.setSimulationMode', async (): Promise<{ deviceId: string; mode: SimMode }> => {
      const d = await deviceDao.findOwned(id, userId);
      if (!d) throw notFound('Device');
      if (!d.simulated) throw unsupported('Only simulated devices can be switched into demo states.');
      if (d.status !== 'active') throw unsupported('This device is disabled.');
      deviceSimulator.setMode(d, mode);
      return { deviceId: id, mode };
    }),
};
