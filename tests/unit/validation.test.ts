import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loginBody, registerBody } from '../../src/validations/public/auth.validation';
import { replaceWidgetsBody } from '../../src/validations/public/dashboard.validation';
import { commandBody, rawPublishBody, telemetryQuery } from '../../src/validations/public/mqtt.validation';
import { createProjectBody, importProjectBody, listProjectsQuery } from '../../src/validations/public/project.validation';
import { createVariableBody } from '../../src/validations/public/variable.validation';
import { widget } from '../../src/validations/public/widget.validation';
import { changeRoleBody } from '../../src/validations/private/user-management.validation';
import { registerDeviceBody } from '../../src/validations/private/device-management.validation';

const oid = 'a'.repeat(24);
const w = (over: Record<string, unknown> = {}) => ({ id: 'wgt_1', type: 'toggle', layout: { x: 0, y: 0, w: 3, h: 3 }, config: { title: 'LED' }, binding: null, ...over });

describe('auth input', () => {
  it('registration cannot carry a role (strict schema)', () => {
    const r = registerBody.safeParse({ name: 'Asha', email: 'a@b.co', password: 'longenough1', role: 'SUPER_ADMIN' });
    assert.equal(r.success, false);
  });
  it('normalises email and enforces password rules', () => {
    const ok = registerBody.parse({ name: 'Asha', email: '  A@B.CO ', password: 'longenough1' });
    assert.equal(ok.email, 'a@b.co');
    assert.equal(registerBody.safeParse({ name: 'Asha', email: 'a@b.co', password: 'short1' }).success, false);
    assert.equal(registerBody.safeParse({ name: 'Asha', email: 'a@b.co', password: 'lettersonlyhere' }).success, false);
  });
  it('rejects operator objects where strings are expected', () => {
    assert.equal(loginBody.safeParse({ email: { $ne: null }, password: 'x' }).success, false);
    assert.equal(loginBody.safeParse({ email: 'a@b.co', password: { $gt: '' } }).success, false);
  });
});

describe('widgets and dashboards', () => {
  it('accepts every documented widget field', () => assert.ok(widget.safeParse(w({ type: 'slider', config: { title: 'Speed', min: 0, max: 255, step: 1, unit: 'PWM', precision: 0, color: 'lime' } })).success));
  it('rejects unknown config keys and out-of-grid layouts', () => {
    assert.equal(widget.safeParse(w({ config: { title: 'x', onclick: 'alert(1)' } })).success, false);
    assert.equal(widget.safeParse(w({ layout: { x: 10, y: 0, w: 4, h: 2 } })).success, false);
    assert.equal(widget.safeParse(w({ type: 'iframe' })).success, false);
    assert.equal(widget.safeParse(w({ config: { title: 'x', min: 5, max: 1 } })).success, false);
  });
  it('requires unique widget ids in a save', () => assert.equal(replaceWidgetsBody.safeParse({ widgets: [w(), w()] }).success, false));
  it('caps widgets per dashboard', () => assert.equal(replaceWidgetsBody.safeParse({ widgets: Array.from({ length: 201 }, (_, i) => w({ id: `w${i}` })) }).success, false));
});

describe('projects and variables', () => {
  it('fills project defaults and rejects unknown categories', () => {
    const p = createProjectBody.parse({ name: 'Smart Room' });
    assert.equal(p.category, 'Custom');
    assert.equal(createProjectBody.safeParse({ name: 'x', category: 'Hacking' }).success, false);
  });
  it('allow-lists sort fields', () => {
    assert.deepEqual(listProjectsQuery.parse({ sort: '-name' }).sort, { field: 'name', direction: -1 });
    assert.equal(listProjectsQuery.safeParse({ sort: 'passwordHash' }).success, false);
  });
  it('checks variable topic shape against direction', () => {
    const base = { key: 'led_state', displayName: 'LED', dataType: 'boolean', direction: 'bidirectional', deviceId: oid };
    assert.equal(createVariableBody.safeParse(base).success, false, 'two-way needs both topics');
    assert.ok(createVariableBody.safeParse({ ...base, stateTopic: 'kokoon/devices/x/telemetry/led_state', commandTopic: 'kokoon/devices/x/command/led_state' }).success);
    assert.equal(createVariableBody.safeParse({ ...base, key: 'LED State' }).success, false);
    assert.equal(createVariableBody.safeParse({ ...base, stateTopic: 'kokoon/#', commandTopic: 'a/b' }).success, false);
  });
  it('accepts a project export bundle and rejects other JSON', () => {
    const bundle = { kind: 'kokoon-iot-studio/project', version: 1, project: { name: 'P' }, dashboards: [{ id: 'd1', name: 'Main', widgets: [w({ binding: { variableId: 'v1' } })] }], variables: [], devices: [] };
    assert.ok(importProjectBody.safeParse(bundle).success);
    assert.equal(importProjectBody.safeParse({ ...bundle, kind: 'something-else' }).success, false);
  });
});

describe('mqtt input', () => {
  it('commands carry a variable id, never a topic', () => {
    assert.ok(commandBody.safeParse({ variableId: oid, value: true }).success);
    assert.equal(commandBody.safeParse({ variableId: oid, value: true, topic: 'x/y' }).success, false);
  });
  it('raw publish validates topic and payload', () => {
    assert.equal(rawPublishBody.safeParse({ topic: 'kokoon/#', payload: '{}' }).success, false);
    assert.equal(rawPublishBody.safeParse({ topic: 'a/b', payload: 'x'.repeat(5000) }).success, false);
  });
  it('telemetry query parses comma-separated ids and rejects junk', () => {
    assert.deepEqual(telemetryQuery.parse({ variableIds: `${oid},${'b'.repeat(24)}` }).variableIds.length, 2);
    assert.equal(telemetryQuery.safeParse({ variableIds: 'not-an-id' }).success, false);
  });
});

describe('admin input', () => {
  it('only known roles can be assigned', () => assert.equal(changeRoleBody.safeParse({ role: 'ROOT' }).success, false));
  it('real device registration validates hardware ids', () => {
    assert.equal(registerDeviceBody.safeParse({ ownerId: oid, name: 'x', hardwareId: 'Bad Id!', board: 'ESP32-C3 Mini' }).success, false);
    assert.ok(registerDeviceBody.safeParse({ ownerId: oid, name: 'Lab node', hardwareId: 'esp32-lab-01', board: 'ESP32-C3 Mini', capabilities: ['temperature'] }).success);
  });
});
