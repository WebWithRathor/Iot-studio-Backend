import { z } from 'zod';
import { DEVICE_BOARDS, DEVICE_KITS, SIM_MODES } from '../../constants/mqtt.constants';
import { objectId, text } from '../shared/common.validation';

const kitKeys = Object.keys(DEVICE_KITS) as [string, ...string[]];

/**
 * Users can only create SIMULATED devices. The server generates the hardware
 * id; a browser can never register a "trusted" real device by inventing an
 * id — real devices are registered by an admin (device-management).
 */
export const createSimulatedDeviceBody = z
  .object({
    name: text(60, 1),
    board: z.enum(DEVICE_BOARDS),
    kit: z.enum(kitKeys),
    projectIds: z.array(objectId).max(20).default([]),
  })
  .strict();

export const renameDeviceBody = z.object({ name: text(60, 1) }).strict();

export const simulationModeBody = z.object({ mode: z.enum(SIM_MODES) }).strict();
