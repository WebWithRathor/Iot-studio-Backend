import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WIDGET_TYPES } from '../../src/constants/app.constants';
import { bindingProblem, diffWidgets, WIDGET_IO } from '../../src/utils/widget-compat.util';

describe('widget ↔ variable compatibility', () => {
  it('covers all 24 frontend widget types', () => {
    assert.equal(WIDGET_TYPES.length, 24);
    for (const t of WIDGET_TYPES) assert.ok(WIDGET_IO[t], t);
  });
  it('controls cannot bind read-only telemetry', () => assert.ok(bindingProblem('toggle', { dataType: 'boolean', direction: 'telemetry' })));
  it('controls need a command topic', () => assert.ok(bindingProblem('slider', { dataType: 'integer', direction: 'bidirectional', commandTopic: null })));
  it('displays accept matching types', () => {
    assert.equal(bindingProblem('gauge', { dataType: 'float', direction: 'telemetry' }), null);
    assert.ok(bindingProblem('gauge', { dataType: 'string', direction: 'telemetry' }));
  });
  it('static widgets have no data source', () => assert.ok(bindingProblem('label', { dataType: 'string', direction: 'telemetry' })));
});

describe('dashboard diff for activity', () => {
  const mk = (id: string, v: string | null) => ({ id, type: 'numeric', config: { title: id }, binding: v ? { variableId: v } : null });
  it('detects added, removed and re-bound widgets only', () => {
    const d = diffWidgets([mk('a', 'v1'), mk('b', null), mk('c', 'v2')], [mk('a', 'v1'), mk('c', 'v3'), mk('d', null)]);
    assert.deepEqual(d.added.map((w) => w.id), ['d']);
    assert.deepEqual(d.removed.map((w) => w.id), ['b']);
    assert.deepEqual(d.rebound.map((w) => w.id), ['c']);
  });
});
