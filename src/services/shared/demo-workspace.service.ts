import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { mqttConfig } from '../../config/mqtt.config';
import type { WidgetType } from '../../constants/app.constants';
import { CAPABILITIES, type CapabilityTemplate } from '../../constants/mqtt.constants';
import { activityDao } from '../../dao/activity.dao';
import { dashboardDao } from '../../dao/dashboard.dao';
import { deviceDao } from '../../dao/device.dao';
import { projectDao } from '../../dao/project.dao';
import { variableDao } from '../../dao/variable.dao';
import type { ActivityDoc } from '../../models/activity.model';
import type { DeviceDoc } from '../../models/device.model';
import type { VariableDoc } from '../../models/variable.model';
import type { WidgetConfigDoc, WidgetDoc } from '../../models/widget.model';
import { channel } from '../../utils/logger.util';
import { defaultDevicePrefix, suggestTopics } from '../../utils/mqtt-topic.util';
import { deviceRegistry } from './device-registry.service';

/**
 * Builds the sample workspace (the same five projects the approved
 * prototype shipped with) for ONE user: four simulated devices, one
 * LMS-origin "real" device that honestly shows no data, projects,
 * dashboards, variables and a little activity history.
 * Used by `npm run seed:dev`, by sign-up when DEMO_WORKSPACE_ON_SIGNUP=true,
 * and by "Reset demo data". Idempotent per user via `ensureFor`.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const wid = () => `wgt_${randomBytes(5).toString('hex')}`;

type W = [WidgetType, number, number, number, number, Partial<WidgetConfigDoc>?, string?];

const DEFAULT_CONFIG: Partial<Record<WidgetType, Partial<WidgetConfigDoc>>> = {
  toggle: { onLabel: 'ON', offLabel: 'OFF', onValue: 'true', offValue: 'false' },
  slider: { min: 0, max: 100, step: 1, defaultValue: 0, precision: 0 },
  arc_slider: { min: 0, max: 100, step: 1, precision: 0 },
  rotary: { min: 0, max: 255, step: 1, precision: 0 },
  numeric: { precision: 1, size: 'lg' },
  gauge: { min: 0, max: 100, precision: 1 },
  progress: { min: 0, max: 100, precision: 0 },
  status: { onLabel: 'ON', offLabel: 'OFF' },
  value_card: { precision: 1 },
  line_chart: { timeWindow: 60, precision: 1 },
  area_chart: { timeWindow: 300, precision: 1 },
  bar_chart: { samples: 16, precision: 0 },
  table: { source: 'variable', samples: 12, precision: 2 },
  label: { size: 'md', align: 'left', showHeader: false },
  event_log: { samples: 20 },
};

async function uniqueHardwareId(base: string): Promise<string> {
  const root = mqttConfig().topicRoot;
  for (let i = 0; i < 6; i++) {
    const hw = `${base}-${randomBytes(2).toString('hex')}`;
    if (!(await deviceDao.existsHardwareOrPrefix(hw, defaultDevicePrefix(root, hw)))) return hw;
  }
  throw new Error('Could not allocate a unique hardware id');
}

const variableFrom = (projectId: Types.ObjectId, ownerId: Types.ObjectId, device: DeviceDoc, t: CapabilityTemplate, createdAt: Date): Omit<VariableDoc, 'createdAt' | 'updatedAt'> => ({
  _id: new Types.ObjectId(),
  projectId,
  ownerId,
  key: t.key,
  displayName: t.displayName,
  dataType: t.dataType,
  direction: t.direction,
  deviceId: device._id,
  ...suggestTopics(device.topicPrefix, t.key, t.direction),
  unit: t.unit,
  min: t.min,
  max: t.max,
  firmwareRef: null,
});

export const demoWorkspaceService = {
  async createFor(userId: string): Promise<{ projects: number; devices: number }> {
    const owner = new Types.ObjectId(userId);
    const root = mqttConfig().topicRoot;
    const now = Date.now();

    const deviceSpecs = [
      { key: 'bench', name: 'ESP32 Demo Bench', base: 'esp32-bench', board: 'ESP32-S3 DevKitC', simulated: true, fw: 'sim-1.4.0', caps: ['temperature', 'humidity', 'led_state', 'motor_speed', 'rgb_color', 'light_level', 'uptime', 'buzzer'], ago: 20 * DAY },
      { key: 'garden', name: 'Garden Node', base: 'esp32-garden', board: 'ESP32-C3 Mini', simulated: true, fw: 'sim-1.2.1', caps: ['soil_moisture', 'temperature', 'humidity', 'pump_state', 'battery'], ago: 14 * DAY },
      { key: 'weather', name: 'Rooftop Weather', base: 'esp32-wx', board: 'ESP32-S3 DevKitC', simulated: true, fw: 'sim-2.0.3', caps: ['temperature', 'humidity', 'pressure', 'wind_speed', 'battery', 'status_text'], ago: 30 * DAY },
      { key: 'rgb', name: 'RGB Light Strip', base: 'esp32-rgb', board: 'ESP32-C3 Mini', simulated: true, fw: 'sim-1.0.7', caps: ['rgb_color', 'brightness', 'led_state'], ago: 9 * DAY },
      { key: 'class', name: 'Classroom BrainBoard', base: 'brainboard-cls', board: 'Kokoon BrainBoard', simulated: false, fw: 'LMS build r14', caps: ['temperature', 'humidity', 'led_state'], ago: 3 * DAY },
    ];

    const devices: Record<string, DeviceDoc> = {};
    for (const s of deviceSpecs) {
      const hw = await uniqueHardwareId(s.base);
      devices[s.key] = await deviceDao.create({
        ownerId: owner,
        name: s.name,
        hardwareId: hw,
        topicPrefix: defaultDevicePrefix(root, hw),
        board: s.board,
        origin: s.simulated ? 'studio' : 'lms',
        simulated: s.simulated,
        status: 'active',
        lmsProgram: s.simulated ? null : { programId: 'lms_prog_room_v2', name: 'Room Monitor v2', version: 'r14', source: 'mock' },
        firmwareVersion: s.fw,
        capabilities: s.caps.map((k) => ({ ...CAPABILITIES[k] })),
        registeredBy: null,
      });
    }

    const activity: Array<Omit<ActivityDoc, '_id'>> = [];
    const addProject = async (p: {
      name: string; description: string; category: string; icon: string; accent: string; device: string; caps: string[]; widgets: W[];
      createdAgo: number; updatedAgo: number; lms?: boolean;
    }) => {
      const d = devices[p.device];
      const projectId = new Types.ObjectId();
      const dashboardId = new Types.ObjectId();
      const createdAt = new Date(now - p.createdAgo);
      const vars = p.caps.map((k) => variableFrom(projectId, owner, d, CAPABILITIES[k], createdAt));
      const widgets: WidgetDoc[] = p.widgets.map(([type, x, y, w, h, cfg, varKey]) => {
        const v = varKey ? vars.find((vv) => vv.key === varKey) : undefined;
        return {
          id: wid(),
          type,
          layout: { x, y, w, h },
          config: { showHeader: true, visible: true, ...DEFAULT_CONFIG[type], title: type, ...cfg, ...(type === 'device_status' ? { deviceId: d._id } : {}) } as WidgetConfigDoc,
          binding: v ? { variableId: v._id } : null,
        };
      });
      await variableDao.createMany(vars);
      // Sample projects are free: the project, and the widgets it ships with (as free slots).
      await dashboardDao.create({ _id: dashboardId, projectId, ownerId: owner, name: 'Main dashboard', widgets, freeWidgets: widgets.length });
      await projectDao.create({
        _id: projectId, ownerId: owner, name: p.name, description: p.description, category: p.category, icon: p.icon, accent: p.accent,
        deviceIds: [d._id], dashboardIds: [dashboardId], defaultDashboardId: dashboardId,
        lmsProgram: p.lms ? { programId: 'lms_prog_room_v2', name: 'Room Monitor v2', version: 'r14', source: 'mock' } : null,
        settings: { density: 'comfortable', showWidgetHeaders: true }, sample: true, lastActivityAt: new Date(now - Math.min(p.updatedAgo, 40 * MIN)),
      });
      activity.push(
        { ownerId: owner, projectId, deviceId: null, type: 'project.created', message: `Project “${p.name}” created`, at: createdAt },
        { ownerId: owner, projectId, deviceId: d._id, type: 'device.associated', message: `${d.name} associated with ${p.name}`, at: new Date(createdAt.getTime() + 4 * MIN) },
        { ownerId: owner, projectId, deviceId: null, type: 'dashboard.updated', message: `Main dashboard updated (${widgets.length} widgets)`, at: new Date(now - p.updatedAgo) },
      );
    };

    await addProject({
      name: 'Weather Station', category: 'Environment', icon: 'LuCloudSun', accent: 'indigo', device: 'weather',
      description: 'Rooftop sensor node reporting temperature, humidity, pressure and wind every few seconds.',
      caps: ['temperature', 'humidity', 'pressure', 'wind_speed', 'battery', 'status_text'], createdAgo: 12 * DAY, updatedAgo: 2 * HOUR,
      widgets: [
        ['gauge', 0, 0, 3, 4, { title: 'Air temperature', min: 0, max: 50, unit: '°C' }, 'temperature'],
        ['value_card', 3, 0, 3, 2, { title: 'Humidity', unit: '%' }, 'humidity'],
        ['value_card', 6, 0, 3, 2, { title: 'Wind', unit: 'km/h' }, 'wind_speed'],
        ['progress', 9, 0, 3, 4, { title: 'Battery', unit: '%' }, 'battery'],
        ['value_card', 3, 2, 3, 2, { title: 'Pressure', unit: 'hPa' }, 'pressure'],
        ['text', 6, 2, 3, 2, { title: 'Station status' }, 'status_text'],
        ['line_chart', 0, 4, 8, 5, { title: 'Temperature — last 5 min', timeWindow: 300, unit: '°C' }, 'temperature'],
        ['device_status', 8, 4, 4, 5, { title: 'Station node' }],
      ],
    });
    await addProject({
      name: 'Smart Garden', category: 'Agriculture', icon: 'LuSprout', accent: 'lime', device: 'garden',
      description: 'Soil moisture monitoring with a remote water pump. Turn the pump on and watch the soil recover.',
      caps: ['soil_moisture', 'temperature', 'humidity', 'pump_state', 'battery'], createdAgo: 8 * DAY, updatedAgo: 26 * HOUR,
      widgets: [
        ['gauge', 0, 0, 4, 4, { title: 'Soil moisture', min: 0, max: 100, unit: '%' }, 'soil_moisture'],
        ['toggle', 4, 0, 4, 2, { title: 'Water pump', onLabel: 'PUMPING', offLabel: 'IDLE' }, 'pump_state'],
        ['status', 4, 2, 4, 2, { title: 'Pump state', onLabel: 'RUNNING', offLabel: 'STOPPED' }, 'pump_state'],
        ['progress', 8, 0, 4, 4, { title: 'Battery', unit: '%' }, 'battery'],
        ['area_chart', 0, 4, 7, 5, { title: 'Soil moisture trend', timeWindow: 300, min: 0, max: 100, unit: '%' }, 'soil_moisture'],
        ['event_log', 7, 4, 5, 5, { title: 'Garden events' }],
      ],
    });
    await addProject({
      name: 'RGB Lighting Controller', category: 'Lighting', icon: 'LuLightbulb', accent: 'rose', device: 'rgb',
      description: 'Colour and brightness control for an addressable LED strip.',
      caps: ['rgb_color', 'brightness', 'led_state'], createdAgo: 5 * DAY, updatedAgo: 3 * DAY,
      widgets: [
        ['color_wheel', 0, 0, 4, 6, { title: 'Strip colour' }, 'rgb_color'],
        ['arc_slider', 4, 0, 4, 4, { title: 'Brightness', unit: '%', min: 0, max: 100 }, 'brightness'],
        ['toggle', 8, 0, 4, 2, { title: 'Strip power' }, 'led_state'],
        ['status', 8, 2, 4, 2, { title: 'Power' }, 'led_state'],
        ['text', 4, 4, 4, 2, { title: 'Reported colour', align: 'center' }, 'rgb_color'],
        ['label', 8, 4, 4, 2, { title: 'Label', text: 'Colour and brightness are sent when you release the control.', size: 'sm' }],
      ],
    });
    await addProject({
      name: 'Motor Test Bench', category: 'Robotics', icon: 'LuCog', accent: 'ink', device: 'bench',
      description: 'Drive a DC motor through the BrainBoard H-bridge and log bench conditions.',
      caps: ['motor_speed', 'temperature', 'light_level', 'led_state', 'uptime'], createdAgo: 18 * DAY, updatedAgo: 5 * HOUR,
      widgets: [
        ['rotary', 0, 0, 3, 4, { title: 'Motor speed', min: 0, max: 255, unit: 'PWM' }, 'motor_speed'],
        ['slider', 3, 0, 6, 2, { title: 'Fine speed', min: 0, max: 255, unit: 'PWM' }, 'motor_speed'],
        ['numeric', 9, 0, 3, 2, { title: 'Reported speed', unit: 'PWM', precision: 0 }, 'motor_speed'],
        ['bar_chart', 3, 2, 6, 4, { title: 'Bench light', unit: 'lux' }, 'light_level'],
        ['gauge', 9, 2, 3, 4, { title: 'Bench temp', min: 0, max: 50, unit: '°C' }, 'temperature'],
        ['toggle', 0, 4, 3, 2, { title: 'Status LED' }, 'led_state'],
        ['table', 0, 6, 12, 4, { title: 'Temperature log', unit: '°C' }, 'temperature'],
      ],
    });
    await addProject({
      name: 'Classroom Monitor', category: 'Environment', icon: 'LuGraduationCap', accent: 'blue', device: 'class', lms: true,
      description: 'Linked to the LMS program “Room Monitor v2”. Uses real hardware, so it shows no data until a broker integration exists.',
      caps: ['temperature', 'humidity', 'led_state'], createdAgo: 2 * DAY, updatedAgo: 2 * DAY,
      widgets: [
        ['numeric', 0, 0, 4, 3, { title: 'Room temperature', unit: '°C' }, 'temperature'],
        ['numeric', 4, 0, 4, 3, { title: 'Room humidity', unit: '%' }, 'humidity'],
        ['toggle', 8, 0, 4, 3, { title: 'Desk LED' }, 'led_state'],
        ['line_chart', 0, 3, 12, 4, { title: 'Temperature', unit: '°C' }, 'temperature'],
      ],
    });

    activity.push({ ownerId: owner, projectId: null, deviceId: devices.class._id, type: 'device.created', message: 'Classroom BrainBoard discovered from LMS program “Room Monitor v2” (mock discovery)', at: new Date(now - 3 * DAY) });
    await activityDao.createMany(activity);
    deviceRegistry.invalidate();
    channel('app').info('demo.workspace.created', { userId, projects: 5, devices: deviceSpecs.length });
    return { projects: 5, devices: deviceSpecs.length };
  },

  /** Create the demo workspace only if the user has no projects yet (idempotent). */
  async ensureFor(userId: string): Promise<boolean> {
    if ((await projectDao.countOwned(userId)) > 0) return false;
    await demoWorkspaceService.createFor(userId);
    return true;
  },
};
