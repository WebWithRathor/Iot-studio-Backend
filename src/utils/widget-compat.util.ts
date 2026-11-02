import type { DataType, Direction, WidgetType } from '../constants/app.constants';

/**
 * Server-side copy of the frontend's widget ↔ variable compatibility rules
 * (frontend: src/widgets/definitions.ts). The server enforces them so an
 * edited request cannot bind, say, a toggle to read-only telemetry.
 */

export type WidgetIO = 'write' | 'read' | 'none';

const NUMERIC: DataType[] = ['integer', 'float'];
const ALL: DataType[] = ['boolean', 'integer', 'float', 'string', 'color', 'json'];

export const WIDGET_IO: Readonly<Record<WidgetType, { io: WidgetIO; accepts: DataType[] }>> = {
  button: { io: 'write', accepts: ['boolean', 'integer', 'string'] },
  toggle: { io: 'write', accepts: ['boolean', 'integer'] },
  slider: { io: 'write', accepts: NUMERIC },
  arc_slider: { io: 'write', accepts: NUMERIC },
  color_wheel: { io: 'write', accepts: ['color', 'string'] },
  rotary: { io: 'write', accepts: NUMERIC },
  stepper: { io: 'write', accepts: NUMERIC },
  mode_selector: { io: 'write', accepts: ['integer', 'string'] },
  momentary: { io: 'write', accepts: ['boolean', 'integer', 'string'] },
  level_bar: { io: 'read', accepts: NUMERIC },
  numeric: { io: 'read', accepts: [...NUMERIC, 'boolean'] },
  text: { io: 'read', accepts: ALL },
  gauge: { io: 'read', accepts: NUMERIC },
  progress: { io: 'read', accepts: NUMERIC },
  status: { io: 'read', accepts: ['boolean', 'integer', 'float', 'string'] },
  value_card: { io: 'read', accepts: NUMERIC },
  line_chart: { io: 'read', accepts: NUMERIC },
  area_chart: { io: 'read', accepts: NUMERIC },
  bar_chart: { io: 'read', accepts: NUMERIC },
  table: { io: 'read', accepts: ALL },
  label: { io: 'none', accepts: [] },
  divider: { io: 'none', accepts: [] },
  device_status: { io: 'none', accepts: [] },
  event_log: { io: 'none', accepts: [] },
};

export interface BindableVariable {
  dataType: DataType;
  direction: Direction;
  commandTopic?: string | null;
}

/** Returns null when the binding is allowed, otherwise the reason it is not. Warnings are allowed. */
export function bindingProblem(type: WidgetType, v: BindableVariable): string | null {
  const spec = WIDGET_IO[type];
  if (spec.io === 'none') return 'This widget type has no data source.';
  if (!spec.accepts.includes(v.dataType)) return `A ${type} widget cannot show ${v.dataType} values.`;
  if (spec.io === 'write' && v.direction === 'telemetry') return 'Read-only telemetry cannot be bound to a control.';
  if (spec.io === 'write' && !v.commandTopic) return 'The variable has no command topic.';
  return null;
}

/** Server-side diff of two widget lists → meaningful activity (not one event per drag). */
export function diffWidgets<W extends { id: string; type: string; config: { title: string }; binding: { variableId: unknown } | null }>(before: W[], after: W[]) {
  const prev = new Map(before.map((w) => [w.id, w]));
  const next = new Map(after.map((w) => [w.id, w]));
  const added = after.filter((w) => !prev.has(w.id));
  const removed = before.filter((w) => !next.has(w.id));
  const rebound = after.filter((w) => {
    const p = prev.get(w.id);
    return p && String(p.binding?.variableId ?? '') !== String(w.binding?.variableId ?? '');
  });
  return { added, removed, rebound };
}

