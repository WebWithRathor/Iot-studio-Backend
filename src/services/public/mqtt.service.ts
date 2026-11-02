import type { Request, Response } from 'express';
import { mqttConfig } from '../../config/mqtt.config';
import { LIMITS } from '../../constants/app.constants';
import { ERROR_CODES } from '../../constants/error-codes.constants';
import { PERMISSIONS } from '../../constants/permissions.constants';
import { deviceDao } from '../../dao/device.dao';
import { mqttMessageDao } from '../../dao/mqtt-message.dao';
import { variableDao } from '../../dao/variable.dao';
import type { DeviceDoc } from '../../models/device.model';
import type { AuthUser } from '../../types/auth.types';
import type { CommandStateDTO, MqttMessageDTO, MqttStatusDTO, SnapshotDTO, TelemetrySampleDTO } from '../../types/mqtt.types';
import { AppError, forbidden, notFound, serviceUnavailable, validationError } from '../../utils/error.util';
import { channel, traced } from '../../utils/logger.util';
import { classifyDeviceTopic, coerceCommandValue, conventionalTopics, decodeValue, encodeValue, isUnderPrefix } from '../../utils/mqtt-topic.util';
import { auditLogService } from '../private/audit-log.service';
import { activityService } from '../shared/activity.service';
import { authorizationService } from '../shared/authorization.service';
import { deviceRegistry } from '../shared/device-registry.service';
import { deviceSimulator } from '../shared/device-simulator.service';
import { mqttConnection } from '../shared/mqtt-connection.service';
import { mqttIngestService, toMessageDTO } from '../shared/mqtt-ingest.service';
import { realtimeService } from '../shared/realtime.service';
import { redisService } from '../shared/redis.service';

/**
 * User-facing MQTT operations. Every operation is scoped to devices the
 * caller OWNS; topics are always resolved server-side from the caller's
 * variables and devices, never trusted from the browser.
 */

const lastCommandActivity = new Map<string, number>();

export function mqttStatus(): MqttStatusDTO {
  const cfg = mqttConfig();
  const sim = deviceSimulator.status();
  return {
    mode: cfg.mode,
    transport: mqttConnection.label(),
    broker: mqttConnection.state(),
    simulation: { enabled: sim.enabled, paused: sim.paused, intervalMs: sim.intervalMs },
    topicRoot: cfg.topicRoot,
  };
}

/** Ownership + state checks before anything is published to a device. */
function assertOperable(user: AuthUser, device: DeviceDoc | null): DeviceDoc {
  if (!device || String(device.ownerId) !== user.id) throw notFound('Device');
  if (device.status !== 'active') throw forbidden('This device has been disabled by an administrator.');
  return device;
}

async function publishAndTrack(user: AuthUser, device: DeviceDoc, topic: string, value: unknown, source: string): Promise<{ message: MqttMessageDTO; command: CommandStateDTO }> {
  if (!mqttConnection.isConnected()) throw serviceUnavailable(ERROR_CODES.MQTT_UNAVAILABLE, 'The MQTT broker is not connected. Commands cannot be sent right now.');
  const payload = encodeValue(value);
  // Record first (status pending) so the ack can be correlated even if it arrives immediately.
  const message = await mqttIngestService.recordOutgoing({ device, topic, payload, status: 'pending', publishedBy: user.id, qos: 1 });
  const failureReason = device.simulated
    ? 'No acknowledgement — the simulated device is offline or paused.'
    : mqttConfig().mode === 'simulated'
      ? 'Not delivered: MQTT_MODE=simulated has no broker, so real hardware cannot be reached.'
      : 'No acknowledgement from the device within 5 s.';
  const command = mqttIngestService.trackCommand({ topic, messageId: message.id, ownerId: user.id, deviceId: String(device._id), value, at: message.at, failureReason });
  realtimeService.toDevice(String(device._id), { type: 'command', data: { topic, command } });
  try {
    await mqttConnection.publish(topic, payload, { qos: 1 });
  } catch (err) {
    channel('mqtt').error('mqtt.publish.failed', { topic, errorName: (err as Error).name });
    throw serviceUnavailable(ERROR_CODES.MQTT_UNAVAILABLE, 'The command could not be published. Try again.');
  }
  const last = lastCommandActivity.get(topic) ?? 0;
  if (Date.now() - last > 3000) {
    lastCommandActivity.set(topic, Date.now());
    await activityService.record({ ownerId: user.id, deviceId: String(device._id), type: 'command.published', message: `${source}: ${topic.split('/').pop()} → ${JSON.stringify(value).slice(0, 60)}${device.simulated ? ' (simulated device)' : ''}` });
  }
  channel('mqtt').info('mqtt.command.published', { topic, deviceId: String(device._id), simulated: device.simulated });
  return { message, command };
}

export const mqttService = {
  status: mqttStatus,

  /** Initial state for the browser runtime: device states, latest values, recent history and messages. */
  snapshot: (user: AuthUser, historyMinutes: number) =>
    traced('MqttService.snapshot', async (): Promise<SnapshotDTO> => {
      const devices = await deviceDao.listOwned(user.id);
      const ids = devices.map((d) => String(d._id));
      const variables = await variableDao.listByOwner(user.id);
      const topics = new Set<string>();
      for (const v of variables) if (v.stateTopic) topics.add(v.stateTopic);
      for (const d of devices) for (const c of d.capabilities) if (c.direction !== 'command') topics.add(conventionalTopics(d.topicPrefix, c.key).telemetry);
      const since = new Date(Date.now() - historyMinutes * 60_000);
      const [values, samples, messages] = await Promise.all([
        redisService.getLatest(ids),
        topics.size ? mqttMessageDao.telemetry(user.id, Array.from(topics), since, LIMITS.SNAPSHOT_HISTORY_MAX_SAMPLES) : Promise.resolve([]),
        ids.length ? mqttMessageDao.list({ ownerId: user.id, limit: LIMITS.SNAPSHOT_MESSAGES }) : Promise.resolve([]),
      ]);
      const history: Record<string, TelemetrySampleDTO[]> = {};
      for (const s of samples) (history[s.topic] ??= []).push({ t: s.at.getTime(), v: s.num as number });
      const runtimes: SnapshotDTO['devices'] = {};
      for (const id of ids) {
        const r = deviceRegistry.runtimeOf(id);
        if (r) runtimes[id] = r;
        else {
          const d = devices.find((x) => String(x._id) === id)!;
          runtimes[id] = { state: d.status === 'active' ? d.connectionState : 'disconnected', lastSeen: d.lastSeenAt?.getTime() ?? null, since: d.connectionSince?.getTime() ?? Date.now(), messageCount: 0, telemetrySeen: Boolean(d.lastSeenAt) };
        }
      }
      return {
        status: mqttStatus(),
        values,
        history,
        messages: messages.reverse().map(toMessageDTO),
        devices: runtimes,
        commands: mqttIngestService.commandsFor(new Set(ids)),
        serverTime: Date.now(),
      };
    }),

  messages: (user: AuthUser, q: { deviceId?: string; direction?: 'in' | 'out'; kind?: 'telemetry' | 'command' | 'ack' | 'availability'; before?: number; limit: number }) =>
    traced('MqttService.messages', async (): Promise<MqttMessageDTO[]> => {
      if (q.deviceId && !(await deviceDao.findOwned(q.deviceId, user.id))) throw notFound('Device');
      const rows = await mqttMessageDao.list({ ownerId: user.id, deviceId: q.deviceId, direction: q.direction, kind: q.kind, before: q.before, limit: q.limit });
      return rows.map(toMessageDTO);
    }),

  /** Chart history for the caller's variables. */
  telemetry: (user: AuthUser, variableIds: string[], since: number | undefined, limit: number) =>
    traced('MqttService.telemetry', async (): Promise<Record<string, TelemetrySampleDTO[]>> => {
      const vars = await variableDao.listOwnedByIds(variableIds, user.id);
      const topics = vars.map((v) => v.stateTopic).filter((t): t is string => Boolean(t));
      if (!topics.length) return {};
      const rows = await mqttMessageDao.telemetry(user.id, topics, new Date(since ?? Date.now() - 15 * 60_000), limit);
      const out: Record<string, TelemetrySampleDTO[]> = {};
      for (const r of rows) (out[r.topic] ??= []).push({ t: r.at.getTime(), v: r.num as number });
      return out;
    }),

  /** Publish a command for one of the caller's variables. The topic comes from the variable, never from the request. */
  sendCommand: (user: AuthUser, variableId: string, rawValue: unknown, source = 'Dashboard') =>
    traced('MqttService.sendCommand', async () => {
      const v = await variableDao.findOwned(variableId, user.id);
      if (!v) throw notFound('Variable');
      if (v.direction === 'telemetry' || !v.commandTopic) throw new AppError(400, ERROR_CODES.UNSUPPORTED_OPERATION, `“${v.key}” is read-only telemetry; it does not accept commands.`);
      if (!v.deviceId) throw new AppError(400, ERROR_CODES.UNSUPPORTED_OPERATION, `“${v.key}” is not linked to a device, so there is nothing to send the command to.`);
      const device = assertOperable(user, deviceRegistry.get(String(v.deviceId)) ?? (await deviceDao.findById(String(v.deviceId))));
      if (!isUnderPrefix(v.commandTopic, device.topicPrefix)) {
        await auditLogService.record({ action: 'mqtt.publish.denied', outcome: 'denied', actor: { id: user.id, role: user.role }, target: { type: 'variable', id: variableId }, metadata: { reason: 'topic_outside_device_namespace' } });
        throw new AppError(403, ERROR_CODES.TOPIC_NOT_ALLOWED, 'The variable’s command topic is outside its device’s namespace.');
      }
      const coerced = coerceCommandValue(rawValue, v.dataType, { min: v.min, max: v.max });
      if (coerced.error) throw validationError(coerced.error, { fieldErrors: { value: coerced.error } });
      return publishAndTrack(user, device, v.commandTopic, coerced.value, source);
    }),

  /**
   * Console "publish test message". Allowed only for command topics inside a
   * device the caller owns. Free-form topics require MQTT_RAW_PUBLISH
   * (DEVELOPER+); everyone else may only publish to their variables' command
   * topics. Device telemetry/availability/ack topics can never be published
   * from the browser (that would spoof the device).
   */
  publishRaw: (user: AuthUser, topic: string, payload: string) =>
    traced('MqttService.publishRaw', async () => {
      const deny = async (reason: string, message: string) => {
        await auditLogService.record({ action: 'mqtt.publish.denied', outcome: 'denied', actor: { id: user.id, role: user.role }, metadata: { reason, topic } });
        throw new AppError(403, ERROR_CODES.TOPIC_NOT_ALLOWED, message);
      };
      const variable = await variableDao.findOwnedByCommandTopic(topic, user.id);
      if (variable) return mqttService.sendCommand(user, String(variable._id), decodeValue(payload), 'Console');
      const device = deviceRegistry.resolveByTopic(topic);
      if (!device || String(device.ownerId) !== user.id) return deny('not_owned', 'You can only publish to command topics of your own devices.');
      const kind = classifyDeviceTopic(topic, device.topicPrefix)?.kind;
      if (kind !== 'command') return deny('not_command_topic', 'Only command topics can be published from the console — telemetry, availability and ack topics belong to the device.');
      if (!authorizationService.hasPermission(user.role, PERMISSIONS.MQTT_RAW_PUBLISH)) return deny('no_raw_permission', 'Publishing to topics without a variable requires the Developer role. Create a variable for this topic instead.');
      assertOperable(user, device);
      return publishAndTrack(user, device, topic, decodeValue(payload), 'Console');
    }),

  /** Open the authenticated Server-Sent Events stream for the caller's devices. */
  openStream: async (req: Request, res: Response): Promise<void> => {
    const user = req.user!;
    const devices = await deviceDao.listOwned(user.id);
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(realtimeService.retryFrame());
    const unregister = realtimeService.register({ userId: user.id, sessionId: user.sessionId, res, deviceIds: devices.map((d) => String(d._id)), endAt: user.exp });
    realtimeService.send(res, { type: 'status', data: mqttStatus() });
    req.on('close', unregister);
  },
};
