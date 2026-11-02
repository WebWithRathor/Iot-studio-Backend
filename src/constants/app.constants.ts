export const APP_NAME = 'kokoon-iot-studio-backend';
export const APP_VERSION = '1.0.0';

export const LIMITS = {
  JSON_BODY: '256kb',
  MAX_WIDGETS_PER_DASHBOARD: 200,
  MAX_DASHBOARDS_PER_PROJECT: 20,
  MAX_PROJECTS_PER_USER: 200,
  MAX_VARIABLES_PER_PROJECT: 200,
  MAX_DEVICES_PER_USER: 50,
  MAX_IMPORT_BYTES: 200_000,
  DEFAULT_PAGE_SIZE: 25,
  MAX_PAGE_SIZE: 100,
  MAX_MESSAGES_PAGE: 500,
  MAX_SANITIZE_DEPTH: 8,
  MAX_ARRAY_LENGTH: 500,
  MAX_OBJECT_KEYS: 200,
  ACTIVITY_PAGE: 100,
  SNAPSHOT_HISTORY_MINUTES: 15,
  SNAPSHOT_HISTORY_MAX_SAMPLES: 20_000,
  SNAPSHOT_MESSAGES: 300,
} as const;

export const ACTIVITY_TYPES = [
  'project.created', 'project.updated', 'project.duplicated', 'project.imported',
  'dashboard.created', 'dashboard.updated', 'dashboard.deleted', 'widget.added', 'widget.removed', 'binding.changed',
  'variable.created', 'variable.updated', 'variable.deleted',
  'device.created', 'device.associated', 'device.connected', 'device.disconnected', 'device.error',
  'telemetry.first', 'command.published', 'command.failed',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const PROJECT_CATEGORIES = ['Smart Home', 'Environment', 'Agriculture', 'Robotics', 'Lighting', 'Energy', 'Custom'] as const;
export const PROJECT_ACCENTS = ['indigo', 'lime', 'ink', 'blue', 'rose', 'amber'] as const;
export const PROJECT_ICONS = [
  'LuHouse', 'LuCloudSun', 'LuSprout', 'LuLightbulb', 'LuCog', 'LuBot', 'LuThermometer', 'LuZap', 'LuWaves', 'LuGraduationCap', 'LuSun', 'LuFlame',
] as const;

export const WIDGET_TYPES = [
  'button', 'toggle', 'slider', 'arc_slider', 'color_wheel', 'rotary', 'stepper', 'mode_selector', 'momentary',
  'numeric', 'text', 'gauge', 'progress', 'status', 'value_card', 'level_bar',
  'line_chart', 'area_chart', 'bar_chart',
  'table', 'label', 'divider', 'device_status', 'event_log',
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const DATA_TYPES = ['boolean', 'integer', 'float', 'string', 'color', 'json'] as const;
export type DataType = (typeof DATA_TYPES)[number];

export const DIRECTIONS = ['telemetry', 'command', 'bidirectional'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const GRID_COLS = 12;
export const GRID_MAX_ROWS = 400;
export const GRID_MAX_H = 24;
