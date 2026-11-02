import { Schema, type Types } from 'mongoose';
import { PROJECT_ACCENTS, WIDGET_TYPES, type WidgetType } from '../constants/app.constants';

/**
 * Widgets are EMBEDDED in their dashboard document (see dashboard.model.ts).
 * The editor loads and saves a dashboard's widgets as one unit (layout moves,
 * undo/redo), so embedding keeps every save atomic and every read one query.
 * Widget ids are stable client-generated strings, unique within a dashboard.
 * widget.dao.ts performs the single-widget operations on this sub-document.
 */
export interface WidgetConfigDoc {
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
  deviceId?: Types.ObjectId;
  source?: 'variable' | 'messages';
  thresholdLow?: number;
  thresholdHigh?: number;
  choices?: string;
}

export interface WidgetDoc {
  id: string;
  type: WidgetType;
  layout: { x: number; y: number; w: number; h: number };
  config: WidgetConfigDoc;
  binding: { variableId: Types.ObjectId; scale?: number; offset?: number } | null;
}

const configSchema = new Schema<WidgetConfigDoc>(
  {
    title: { type: String, required: true, maxlength: 80 },
    description: { type: String, maxlength: 200 },
    showHeader: Boolean,
    visible: Boolean,
    color: { type: String, enum: PROJECT_ACCENTS },
    label: { type: String, maxlength: 60 },
    unit: { type: String, maxlength: 16 },
    precision: { type: Number, min: 0, max: 6 },
    min: Number,
    max: Number,
    step: Number,
    defaultValue: Number,
    onValue: { type: String, maxlength: 64 },
    offValue: { type: String, maxlength: 64 },
    onLabel: { type: String, maxlength: 32 },
    offLabel: { type: String, maxlength: 32 },
    pressValue: { type: String, maxlength: 64 },
    timeWindow: Number,
    samples: Number,
    text: { type: String, maxlength: 500 },
    align: { type: String, enum: ['left', 'center'] },
    size: { type: String, enum: ['sm', 'md', 'lg'] },
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device' },
    source: { type: String, enum: ['variable', 'messages'] },
    thresholdLow: Number,
    thresholdHigh: Number,
    choices: { type: String, maxlength: 300 },
  },
  { _id: false, strict: 'throw' },
);

export const widgetSchema = new Schema<WidgetDoc>(
  {
    id: { type: String, required: true, maxlength: 64 },
    type: { type: String, enum: WIDGET_TYPES, required: true },
    layout: {
      x: { type: Number, required: true, min: 0, max: 11 },
      y: { type: Number, required: true, min: 0 },
      w: { type: Number, required: true, min: 1, max: 12 },
      h: { type: Number, required: true, min: 1, max: 24 },
    },
    config: { type: configSchema, required: true },
    binding: {
      type: new Schema(
        {
          variableId: { type: Schema.Types.ObjectId, ref: 'Variable', required: true },
          scale: Number,
          offset: Number,
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { _id: false, strict: 'throw' },
);
