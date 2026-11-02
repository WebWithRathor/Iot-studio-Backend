import { z } from 'zod';
import { LIMITS } from '../../constants/app.constants';
import { text } from '../shared/common.validation';
import { widget } from './widget.validation';

export const createDashboardBody = z.object({ name: text(60, 1) }).strict();

export const renameDashboardBody = z.object({ name: text(60, 1) }).strict();

/**
 * The editor saves the whole widget array (moves, resizes, undo/redo are
 * batch operations). `revision` is the revision the client last saw; a stale
 * revision is rejected with 409 REVISION_CONFLICT instead of silently
 * overwriting a newer save.
 */
export const replaceWidgetsBody = z
  .object({
    widgets: z.array(widget).max(LIMITS.MAX_WIDGETS_PER_DASHBOARD),
    revision: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((b) => new Set(b.widgets.map((w) => w.id)).size === b.widgets.length, { message: 'widget ids must be unique', path: ['widgets'] });
