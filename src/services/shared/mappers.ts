import { DEFAULT_PLAN } from '../../constants/plans.constants';
import type { DashboardDoc } from '../../models/dashboard.model';
import type { DeviceDoc } from '../../models/device.model';
import type { ProjectDoc } from '../../models/project.model';
import type { UserDoc } from '../../models/user.model';
import type { VariableDoc } from '../../models/variable.model';
import type { WidgetDoc } from '../../models/widget.model';
import type { DashboardDTO, DeviceDTO, ProjectDTO, VariableDTO, WidgetDTO } from '../../types/project.types';
import type { UserDTO } from '../../types/user.types';
import { toEpoch, toEpochOrNull } from '../../utils/date.util';
import { authorizationService } from './authorization.service';

/**
 * Document → DTO mapping. DTOs match the frontend's models exactly (string
 * ids, epoch-ms timestamps) so the UI needs no reshaping. Internal fields
 * (ownerId, password hashes, counters) never leave the server.
 */

const clean = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined || o[k] === null) delete o[k];
  return o;
};

export const toUserDTO = (u: Omit<UserDoc, 'passwordHash' | 'failedLogins' | 'lockedUntil'>): UserDTO => ({
  id: String(u._id),
  name: u.name,
  email: u.email,
  role: u.role,
  permissions: authorizationService.permissionsOf(u.role),
  initials: u.name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?',
  status: u.status,
  source: u.authProvider === 'lms' ? 'lms' : 'local',
  passwordSet: u.passwordSet !== false,
  preferences: { onboardingDismissed: Boolean(u.preferences?.onboardingDismissed) },
  plan: u.plan ?? DEFAULT_PLAN,
  createdAt: toEpoch(u.createdAt),
  lastLoginAt: toEpochOrNull(u.lastLoginAt),
});

export const toProjectDTO = (p: ProjectDoc): ProjectDTO => ({
  id: String(p._id),
  name: p.name,
  description: p.description ?? '',
  category: p.category,
  icon: p.icon,
  accent: p.accent,
  createdAt: toEpoch(p.createdAt),
  updatedAt: toEpoch(p.updatedAt),
  lastActivityAt: toEpoch(p.lastActivityAt ?? p.updatedAt),
  deviceIds: (p.deviceIds ?? []).map(String),
  dashboardIds: (p.dashboardIds ?? []).map(String),
  defaultDashboardId: p.defaultDashboardId ? String(p.defaultDashboardId) : String(p.dashboardIds?.[0] ?? ''),
  lmsProgram: p.lmsProgram ? clean({ programId: p.lmsProgram.programId, name: p.lmsProgram.name, version: p.lmsProgram.version, source: p.lmsProgram.source }) : null,
  settings: { density: p.settings?.density ?? 'comfortable', showWidgetHeaders: p.settings?.showWidgetHeaders ?? true },
  sample: Boolean(p.sample),
});

export const toWidgetDTO = (w: WidgetDoc): WidgetDTO => {
  const config = clean({ ...w.config, deviceId: w.config.deviceId ? String(w.config.deviceId) : undefined }) as WidgetDTO['config'];
  return {
    id: w.id,
    type: w.type,
    layout: { x: w.layout.x, y: w.layout.y, w: w.layout.w, h: w.layout.h },
    config,
    binding: w.binding ? clean({ variableId: String(w.binding.variableId), scale: w.binding.scale, offset: w.binding.offset }) : null,
  };
};

export const toDashboardDTO = (d: DashboardDoc): DashboardDTO => ({
  id: String(d._id),
  projectId: String(d.projectId),
  name: d.name,
  widgets: (d.widgets ?? []).map(toWidgetDTO),
  revision: d.revision ?? 0,
  freeWidgets: d.freeWidgets ?? 0,
  createdAt: toEpoch(d.createdAt),
  updatedAt: toEpoch(d.updatedAt),
});

export const toDeviceDTO = (d: DeviceDoc): DeviceDTO =>
  clean({
    id: String(d._id),
    name: d.name,
    hardwareId: d.hardwareId,
    board: d.board,
    origin: d.origin,
    simulated: d.simulated,
    lmsProgram: d.lmsProgram ? clean({ ...d.lmsProgram }) : null,
    firmwareVersion: d.firmwareVersion,
    capabilities: (d.capabilities ?? []).map((c) => clean({ key: c.key, displayName: c.displayName, dataType: c.dataType, direction: c.direction, unit: c.unit, min: c.min, max: c.max })),
    topicPrefix: d.topicPrefix,
    status: d.status,
    createdAt: toEpoch(d.createdAt),
  }) as DeviceDTO;

export const toVariableDTO = (v: VariableDoc): VariableDTO =>
  ({
    ...clean({
      id: String(v._id),
      projectId: String(v.projectId),
      key: v.key,
      displayName: v.displayName,
      dataType: v.dataType,
      direction: v.direction,
      stateTopic: v.stateTopic,
      commandTopic: v.commandTopic,
      unit: v.unit,
      min: v.min,
      max: v.max,
      createdAt: toEpoch(v.createdAt),
    }),
    deviceId: v.deviceId ? String(v.deviceId) : null,
    firmwareRef: v.firmwareRef ?? null,
  }) as VariableDTO;
