import { mqttMessageDao } from '../../dao/mqtt-message.dao';
import type { AuthUser } from '../../types/auth.types';
import { traced } from '../../utils/logger.util';
import { mqttStatus } from '../public/mqtt.service';
import { deviceSimulator } from '../shared/device-simulator.service';
import { mqttConnection } from '../shared/mqtt-connection.service';
import { toMessageDTO } from '../shared/mqtt-ingest.service';
import { realtimeService } from '../shared/realtime.service';
import { auditLogService } from './audit-log.service';

/**
 * Broker/simulation administration. The simulator is shared by every user,
 * so pausing it or changing its interval is an ADMIN action (MQTT_MANAGE).
 */
export const mqttManagementService = {
  status: () => ({ ...mqttStatus(), subscriptions: mqttConnection.subscribedFilters(), sseConnections: realtimeService.count() }),

  setSimulation: (actor: AuthUser, input: { paused?: boolean; intervalMs?: number }) =>
    traced('MqttManagementService.setSimulation', async () => {
      const before = deviceSimulator.status();
      if (input.paused !== undefined) deviceSimulator.setPaused(input.paused);
      if (input.intervalMs !== undefined) deviceSimulator.setIntervalMs(input.intervalMs);
      const status = mqttStatus();
      realtimeService.broadcast({ type: 'status', data: status });
      await auditLogService.record({ action: 'mqtt.simulation.change', outcome: 'success', actor: { id: actor.id, role: actor.role }, metadata: { before, after: deviceSimulator.status() } });
      return status;
    }),

  messages: (q: { deviceId?: string; ownerId?: string; kind?: 'telemetry' | 'command' | 'ack' | 'availability'; direction?: 'in' | 'out'; before?: number; limit: number }) =>
    traced('MqttManagementService.messages', async () => (await mqttMessageDao.list(q)).map(toMessageDTO)),
};
