/**
 * DTOs returned to the frontend. Field names and shapes deliberately mirror
 * the frontend's `src/types/models.ts` (the integration contract): string
 * ids, epoch-millisecond timestamps, embedded widgets.
 */
import type { ActivityType, DataType, Direction, WidgetType } from '../constants/app.constants';
import type { TokenStateDTO } from './token.types';

export interface LmsProgramRefDTO {
  programId: string;
  name: string;
  version?: string;
  source: 'mock' | 'lms';
}

export interface ProjectSettingsDTO {
  density: 'compact' | 'comfortable';
  showWidgetHeaders: boolean;
}

export interface ProjectDTO {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  accent: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  deviceIds: string[];
  dashboardIds: string[];
  defaultDashboardId: string;
  lmsProgram: LmsProgramRefDTO | null;
  settings: ProjectSettingsDTO;
  /** Sample project: free of tokens. */
  sample: boolean;
}

export interface WidgetLayoutDTO {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WidgetConfigDTO {
  title: string;
  description?: string;
  showHeader?: boolean;
  visible?: boolean;
  color?: string;
  label?: string;
  unit?: string;
  precision?: number;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
  onValue?: string;
  offValue?: string;
  onLabel?: string;
  offLabel?: string;
  pressValue?: string;
  timeWindow?: number;
  samples?: number;
  text?: string;
  align?: 'left' | 'center';
  size?: 'sm' | 'md' | 'lg';
  deviceId?: string;
  source?: 'variable' | 'messages';
  thresholdLow?: number;
  thresholdHigh?: number;
  choices?: string;
}

export interface BindingDTO {
  variableId: string;
  scale?: number;
  offset?: number;
}

export interface WidgetDTO {
  id: string;
  type: WidgetType;
  layout: WidgetLayoutDTO;
  config: WidgetConfigDTO;
  binding: BindingDTO | null;
}

export interface DashboardDTO {
  id: string;
  projectId: string;
  name: string;
  widgets: WidgetDTO[];
  revision: number;
  /** Widgets that cost no tokens on this dashboard. */
  freeWidgets: number;
  createdAt: number;
  updatedAt: number;
}

export interface VariableTemplateDTO {
  key: string;
  displayName: string;
  dataType: DataType;
  direction: Direction;
  unit?: string;
  min?: number;
  max?: number;
}

export interface DeviceDTO {
  id: string;
  name: string;
  hardwareId: string;
  board: string;
  origin: 'studio' | 'lms';
  simulated: boolean;
  lmsProgram: LmsProgramRefDTO | null;
  firmwareVersion?: string;
  capabilities: VariableTemplateDTO[];
  topicPrefix: string;
  status: 'active' | 'disabled';
  createdAt: number;
}

export interface VariableDTO {
  id: string;
  projectId: string;
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
  firmwareRef: { source: 'lms'; blockId: string; variableName: string; declared?: boolean } | null;
  createdAt: number;
}

export interface ActivityEventDTO {
  id: string;
  type: ActivityType;
  message: string;
  at: number;
  projectId?: string | null;
  deviceId?: string | null;
}

export interface WorkspaceDTO {
  schemaVersion: 1;
  projects: ProjectDTO[];
  dashboards: DashboardDTO[];
  variables: VariableDTO[];
  devices: DeviceDTO[];
  activity: ActivityEventDTO[];
  preferences: { simIntervalMs: number; onboardingDismissed: boolean };
  tokens: TokenStateDTO;
}

export interface ProjectBundle {
  kind: 'kokoon-iot-studio/project';
  version: 1;
  exportedAt: string;
  project: ProjectDTO;
  dashboards: DashboardDTO[];
  variables: VariableDTO[];
  devices: { id: string; name: string; hardwareId: string }[];
}
