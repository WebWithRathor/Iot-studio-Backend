import { Types } from 'mongoose';
import { LIMITS } from '../../constants/app.constants';
import { activityDao } from '../../dao/activity.dao';
import { dashboardDao } from '../../dao/dashboard.dao';
import { deviceDao } from '../../dao/device.dao';
import { projectDao, type ProjectListOptions } from '../../dao/project.dao';
import { variableDao } from '../../dao/variable.dao';
import { withTransaction } from '../../database/mongo.transactions';
import type { DeviceDoc } from '../../models/device.model';
import type { LmsProgramRef, ProjectDoc } from '../../models/project.model';
import type { VariableDoc } from '../../models/variable.model';
import type { WidgetDoc } from '../../models/widget.model';
import type { Page } from '../../types/common.types';
import type { ActivityEventDTO, DashboardDTO, ProjectBundle, ProjectDTO, VariableDTO } from '../../types/project.types';
import { limitReached, notFound, validationError } from '../../utils/error.util';
import { oid } from '../../utils/id.util';
import { traced } from '../../utils/logger.util';
import { isUnderPrefix, suggestTopics } from '../../utils/mqtt-topic.util';
import { bindingProblem } from '../../utils/widget-compat.util';
import type { ImportProjectInput } from '../../validations/public/project.validation';
import { escapeRegex } from '../../validations/shared/common.validation';
import { TOKEN_COSTS } from '../../constants/plans.constants';
import { activityService, toActivityDTO } from '../shared/activity.service';
import { deviceRegistry } from '../shared/device-registry.service';
import { toDashboardDTO, toProjectDTO, toVariableDTO } from '../shared/mappers';
import { graphCost, tokenWallet } from '../shared/token-wallet.service';
import { sandboxPrefix, variableService } from './variable.service';

export interface ProjectCreateInput {
  name: string;
  description: string;
  category: string;
  icon: string;
  accent: string;
  deviceIds: string[];
  lmsProgram: LmsProgramRef | null;
  importVariables: boolean;
}

export interface ProjectGraph {
  project: ProjectDTO;
  dashboards: DashboardDTO[];
  variables: VariableDTO[];
}

async function ownedProject(userId: string, id: string): Promise<ProjectDoc> {
  const p = await projectDao.findOwned(id, userId);
  if (!p) throw notFound('Project');
  return p;
}

async function assertCapacity(userId: string) {
  if ((await projectDao.countOwned(userId)) >= LIMITS.MAX_PROJECTS_PER_USER) throw limitReached(`You can have at most ${LIMITS.MAX_PROJECTS_PER_USER} projects.`);
}

interface CloneSource {
  project: { name: string; description: string; category: string; icon: string; accent: string; settings?: ProjectDoc['settings']; lmsProgram?: LmsProgramRef | null; defaultDashboardId?: string };
  dashboards: Array<{ id: string; name: string; widgets: Array<{ id: string; type: WidgetDoc['type']; layout: WidgetDoc['layout']; config: Record<string, unknown>; binding: { variableId: string; scale?: number; offset?: number } | null }> }>;
  variables: Array<{ id: string; key: string; displayName: string; dataType: VariableDoc['dataType']; direction: VariableDoc['direction']; deviceId?: string | null; stateTopic?: string; commandTopic?: string; unit?: string; min?: number; max?: number }>;
  /** Device id in the source → owned device to link to (or absent). */
  deviceMap: Map<string, DeviceDoc>;
}

/**
 * Create a brand-new project graph (new ids for everything) from a source:
 * used by duplicate and import. Bindings are re-linked to the new variable
 * ids; variables whose device cannot be resolved to one of the caller's
 * devices are moved into the caller's sandbox namespace (topic policy).
 */
async function cloneGraph(userId: string, src: CloneSource, name: string): Promise<ProjectGraph> {
  const owner = oid(userId);
  const projectId = new Types.ObjectId();
  const varIdMap = new Map<string, Types.ObjectId>();
  const variables: Array<Omit<VariableDoc, 'createdAt' | 'updatedAt'>> = src.variables.map((v) => {
    const nid = new Types.ObjectId();
    varIdMap.set(v.id, nid);
    const device = v.deviceId ? src.deviceMap.get(v.deviceId) ?? null : null;
    const prefix = device ? device.topicPrefix : sandboxPrefix(userId);
    const keep = (t?: string) => (t && isUnderPrefix(t, prefix) ? t : undefined);
    const topics = suggestTopics(prefix, v.key, v.direction);
    return {
      _id: nid, projectId, ownerId: owner, key: v.key, displayName: v.displayName, dataType: v.dataType, direction: v.direction,
      deviceId: device ? device._id : null,
      stateTopic: v.direction === 'command' ? undefined : keep(v.stateTopic) ?? topics.stateTopic,
      commandTopic: v.direction === 'telemetry' ? undefined : keep(v.commandTopic) ?? topics.commandTopic,
      unit: v.unit, min: v.min, max: v.max, firmwareRef: null,
    };
  });
  const varById = new Map(variables.map((v) => [String(v._id), v]));
  const dashIdMap = new Map<string, Types.ObjectId>();
  const dashboards = src.dashboards.map((d) => {
    const nid = new Types.ObjectId();
    dashIdMap.set(d.id, nid);
    const widgets: WidgetDoc[] = d.widgets.map((w) => {
      const newVar = w.binding ? varIdMap.get(w.binding.variableId) : undefined;
      const v = newVar ? varById.get(String(newVar)) : undefined;
      const compatible = v && !bindingProblem(w.type, { dataType: v.dataType, direction: v.direction, commandTopic: v.commandTopic });
      const cfgDevice = typeof w.config.deviceId === 'string' ? src.deviceMap.get(w.config.deviceId) : undefined;
      return {
        id: w.id,
        type: w.type,
        layout: w.layout,
        config: { ...(w.config as unknown as WidgetDoc['config']), deviceId: cfgDevice ? cfgDevice._id : undefined },
        binding: newVar && compatible ? { variableId: newVar, scale: w.binding!.scale, offset: w.binding!.offset } : null,
      };
    });
    return { _id: nid, projectId, ownerId: owner, name: d.name, widgets };
  });
  const dashboardIds = dashboards.map((d) => d._id);
  const devices = Array.from(new Set(Array.from(src.deviceMap.values()).map((d) => String(d._id)))).map(oid);
  const created = await withTransaction('project.clone', async (session) => {
    const v = await variableDao.createMany(variables, session);
    const ds = await dashboardDao.createMany(dashboards, session);
    const p = await projectDao.create({
      _id: projectId, ownerId: owner, name, description: src.project.description ?? '', category: src.project.category, icon: src.project.icon, accent: src.project.accent,
      deviceIds: devices, dashboardIds, defaultDashboardId: (src.project.defaultDashboardId && dashIdMap.get(src.project.defaultDashboardId)) || dashboardIds[0],
      lmsProgram: src.project.lmsProgram ?? null, settings: src.project.settings ?? { density: 'comfortable', showWidgetHeaders: true }, lastActivityAt: new Date(),
    }, session);
    return { p, ds, v };
  });
  deviceRegistry.invalidate();
  return { project: toProjectDTO(created.p), dashboards: created.ds.map(toDashboardDTO), variables: created.v.map(toVariableDTO) };
}

export const projectService = {
  list: (userId: string, q: { q?: string; category?: string; sort: ProjectListOptions['sort']; page: number; pageSize: number }) =>
    traced('ProjectService.list', async (): Promise<Page<ProjectDTO>> => {
      const r = await projectDao.listOwned(userId, { ...q, q: q.q ? escapeRegex(q.q) : undefined });
      return { ...r, items: r.items.map(toProjectDTO) };
    }),

  get: (userId: string, id: string) => traced('ProjectService.get', async () => toProjectDTO(await ownedProject(userId, id))),

  /** Creates the project, its first dashboard and (optionally) the variables its devices declare. */
  create: (userId: string, input: ProjectCreateInput) =>
    traced('ProjectService.create', (): Promise<ProjectGraph> => tokenWallet.withWallet(userId, async () => {
      await assertCapacity(userId);
      await tokenWallet.assertCanAfford(userId, TOKEN_COSTS.project, 'create a project');
      const devices = input.deviceIds.length ? await deviceDao.findOwnedByIds(input.deviceIds, userId) : [];
      if (devices.length !== new Set(input.deviceIds).size) throw validationError('One or more devices were not found.', { fieldErrors: { deviceIds: 'Pick devices from your device list.' } });
      const projectId = new Types.ObjectId();
      const dashboardId = new Types.ObjectId();
      const vars = input.importVariables ? variableService.fromDeviceCapabilities(userId, projectId, devices) : [];
      const created = await withTransaction('project.create', async (session) => {
        const d = await dashboardDao.create({ _id: dashboardId, projectId, ownerId: oid(userId), name: 'Main dashboard' }, session);
        const v = await variableDao.createMany(vars, session);
        const p = await projectDao.create({
          _id: projectId, ownerId: oid(userId), name: input.name, description: input.description, category: input.category, icon: input.icon, accent: input.accent,
          deviceIds: devices.map((x) => x._id), dashboardIds: [dashboardId], defaultDashboardId: dashboardId, lmsProgram: input.lmsProgram,
          settings: { density: 'comfortable', showWidgetHeaders: true }, lastActivityAt: new Date(),
        }, session);
        return { p, d, v };
      });
      const pid = String(projectId);
      await activityService.record({ ownerId: userId, projectId: pid, type: 'project.created', message: `Project “${input.name}” created` });
      for (const d of devices) await activityService.record({ ownerId: userId, projectId: pid, deviceId: String(d._id), type: 'device.associated', message: `${d.name} associated with ${input.name}` });
      if (vars.length) await activityService.record({ ownerId: userId, projectId: pid, type: 'variable.created', message: `${vars.length} variables imported from device declarations` });
      if (vars.length) deviceRegistry.invalidate();
      return { project: toProjectDTO(created.p), dashboards: [toDashboardDTO(created.d)], variables: created.v.map(toVariableDTO) };
    })),

  update: (userId: string, id: string, patch: Partial<Omit<ProjectCreateInput, 'deviceIds' | 'importVariables'>> & { settings?: ProjectDoc['settings']; defaultDashboardId?: string }) =>
    traced('ProjectService.update', async (): Promise<ProjectDTO> => {
      const p = await ownedProject(userId, id);
      if (patch.defaultDashboardId && !p.dashboardIds.some((d) => String(d) === patch.defaultDashboardId)) {
        throw validationError('That dashboard is not part of this project.', { fieldErrors: { defaultDashboardId: 'Choose one of this project’s dashboards.' } });
      }
      const { defaultDashboardId, ...rest } = patch;
      const updated = await projectDao.updateOwned(id, userId, { ...rest, ...(defaultDashboardId ? { defaultDashboardId: oid(defaultDashboardId) } : {}) });
      if (!updated) throw notFound('Project');
      if (patch.name || patch.description !== undefined) await activityService.record({ ownerId: userId, projectId: id, type: 'project.updated', message: 'Project details updated' });
      return toProjectDTO(updated);
    }),

  /** Removes the project with its dashboards, variables and activity. Devices are shared and kept. */
  remove: (userId: string, id: string) =>
    traced('ProjectService.remove', async (): Promise<{ id: string }> => {
      await ownedProject(userId, id);
      await withTransaction('project.delete', async (session) => {
        await dashboardDao.deleteByProject(id, session);
        await variableDao.deleteByProject(id, session);
        await activityDao.deleteByProject(id, session);
        await projectDao.deleteOwned(id, userId, session);
      });
      deviceRegistry.invalidate();
      return { id };
    }),

  exportBundle: (userId: string, id: string) =>
    traced('ProjectService.exportBundle', async (): Promise<ProjectBundle> => {
      const p = await ownedProject(userId, id);
      const [dashboards, variables, devices] = await Promise.all([
        dashboardDao.listByProject(id, userId),
        variableDao.listByProject(id, userId),
        p.deviceIds.length ? deviceDao.findOwnedByIds(p.deviceIds.map(String), userId) : Promise.resolve([]),
      ]);
      return {
        kind: 'kokoon-iot-studio/project',
        version: 1,
        exportedAt: new Date().toISOString(),
        project: toProjectDTO(p),
        dashboards: dashboards.map(toDashboardDTO),
        variables: variables.map(toVariableDTO),
        devices: devices.map((d) => ({ id: String(d._id), name: d.name, hardwareId: d.hardwareId })),
      };
    }),

  duplicate: (userId: string, id: string) =>
    traced('ProjectService.duplicate', (): Promise<ProjectGraph> => tokenWallet.withWallet(userId, async () => {
      await assertCapacity(userId);
      const b = await projectService.exportBundle(userId, id);
      await tokenWallet.assertCanAfford(userId, graphCost(b.dashboards.map((d) => d.widgets.length)), 'duplicate this project');
      const owned = b.devices.length ? await deviceDao.findOwnedByIds(b.devices.map((d) => d.id), userId) : [];
      const graph = await cloneGraph(userId, {
        project: { ...b.project, settings: b.project.settings },
        dashboards: b.dashboards.map((d) => ({ id: d.id, name: d.name, widgets: d.widgets.map((w) => ({ ...w, config: { ...w.config } })) })),
        variables: b.variables,
        deviceMap: new Map(owned.map((d) => [String(d._id), d])),
      }, `${b.project.name} (copy)`.slice(0, 60));
      await activityService.record({ ownerId: userId, projectId: graph.project.id, type: 'project.duplicated', message: `Duplicated from “${b.project.name}”` });
      return graph;
    })),

  /** Import a JSON export. Bundle ids only re-link records inside the bundle; devices are matched by hardware id among YOUR devices. */
  importBundle: (userId: string, bundle: ImportProjectInput) =>
    traced('ProjectService.importBundle', (): Promise<ProjectGraph> => tokenWallet.withWallet(userId, async () => {
      await assertCapacity(userId);
      await tokenWallet.assertCanAfford(userId, graphCost(bundle.dashboards.map((d) => d.widgets.length)), 'import this project');
      const mine = await deviceDao.listOwned(userId);
      const byHw = new Map(mine.map((d) => [d.hardwareId, d]));
      const deviceMap = new Map<string, DeviceDoc>();
      for (const d of bundle.devices) {
        const match = byHw.get(d.hardwareId);
        if (match) deviceMap.set(d.id, match);
      }
      const graph = await cloneGraph(userId, {
        project: { name: bundle.project.name, description: bundle.project.description, category: bundle.project.category, icon: bundle.project.icon, accent: bundle.project.accent, settings: bundle.project.settings, lmsProgram: bundle.project.lmsProgram ?? null, defaultDashboardId: bundle.project.defaultDashboardId },
        dashboards: bundle.dashboards.map((d) => ({ id: d.id, name: d.name, widgets: d.widgets as CloneSource['dashboards'][number]['widgets'] })),
        variables: bundle.variables,
        deviceMap,
      }, `${bundle.project.name} (imported)`.slice(0, 60));
      await activityService.record({ ownerId: userId, projectId: graph.project.id, type: 'project.imported', message: 'Imported from a project file' });
      return graph;
    })),

  associateDevice: (userId: string, id: string, deviceId: string) =>
    traced('ProjectService.associateDevice', async (): Promise<ProjectDTO> => {
      const p = await ownedProject(userId, id);
      const device = await deviceDao.findOwned(deviceId, userId);
      if (!device) throw notFound('Device');
      const updated = await projectDao.addDevice(id, userId, deviceId);
      if (!p.deviceIds.some((d) => String(d) === deviceId)) {
        await activityService.record({ ownerId: userId, projectId: id, deviceId, type: 'device.associated', message: `${device.name} associated with ${p.name}` });
      }
      return toProjectDTO(updated!);
    }),

  dissociateDevice: (userId: string, id: string, deviceId: string) =>
    traced('ProjectService.dissociateDevice', async (): Promise<ProjectDTO> => {
      const p = await ownedProject(userId, id);
      const device = await deviceDao.findOwned(deviceId, userId);
      const updated = await projectDao.removeDevice(id, userId, deviceId);
      if (device && p.deviceIds.some((d) => String(d) === deviceId)) {
        await activityService.record({ ownerId: userId, projectId: id, deviceId, type: 'device.associated', message: `${device.name} removed from ${p.name} (its variables keep their topics)` });
      }
      return toProjectDTO(updated!);
    }),

  activity: (userId: string, id: string, limit: number, before?: number) =>
    traced('ProjectService.activity', async (): Promise<ActivityEventDTO[]> => {
      const p = await ownedProject(userId, id);
      return (await activityDao.listForProject(userId, id, p.deviceIds.map(String), limit, before)).map(toActivityDTO);
    }),
};
