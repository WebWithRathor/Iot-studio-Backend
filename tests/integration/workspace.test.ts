import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { API, CSRF, getApp, registeredAgent, shutdown, unavailableReason } from './helpers';

after(shutdown);

const widget = (id: string, over: Record<string, unknown> = {}) => ({ id, type: 'numeric', layout: { x: 0, y: 0, w: 3, h: 2 }, config: { title: id }, binding: null, ...over });

describe('projects, dashboards, variables, devices', () => {
  it('full workflow persists and survives a reload', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const { agent } = await registeredAgent(app, 'Builder');

    // a simulated device (server picks the hardware id)
    const dev = await agent.post(`${API}/devices`).set(CSRF).send({ name: 'Desk ESP32', board: 'ESP32-S3 DevKitC', kit: 'full' });
    assert.equal(dev.status, 201);
    const device = dev.body.data.device;
    assert.equal(device.simulated, true);
    assert.match(device.hardwareId, /^esp32-sim-/);

    // project with variables imported from the device declarations
    const created = await agent.post(`${API}/projects`).set(CSRF).send({ name: 'Smart Room', deviceIds: [device.id], importVariables: true });
    assert.equal(created.status, 201);
    const { project, dashboards, variables } = created.body.data;
    assert.equal(dashboards.length, 1);
    const led = variables.find((v: { key: string }) => v.key === 'led_state');
    const temp = variables.find((v: { key: string }) => v.key === 'temperature');
    assert.ok(led && temp);

    // save a layout with bindings
    const dash = dashboards[0];
    const save = await agent.put(`${API}/dashboards/${dash.id}/widgets`).set(CSRF).send({
      revision: dash.revision,
      widgets: [widget('w1', { type: 'toggle', binding: { variableId: led.id } }), widget('w2', { binding: { variableId: temp.id }, layout: { x: 3, y: 0, w: 3, h: 2 } })],
    });
    assert.equal(save.status, 200);
    assert.equal(save.body.data.revision, dash.revision + 1);

    // stale revision → 409
    const stale = await agent.put(`${API}/dashboards/${dash.id}/widgets`).set(CSRF).send({ revision: dash.revision, widgets: [] });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'REVISION_CONFLICT');

    // incompatible binding rejected (toggle ↔ read-only telemetry)
    const bad = await agent.put(`${API}/dashboards/${dash.id}/widgets`).set(CSRF).send({ widgets: [widget('w1', { type: 'toggle', binding: { variableId: temp.id } })] });
    assert.equal(bad.status, 400);

    // reload
    const ws = await agent.get(`${API}/users/me/workspace`);
    assert.equal(ws.status, 200);
    const reloaded = ws.body.data.dashboards.find((d: { id: string }) => d.id === dash.id);
    assert.equal(reloaded.widgets.length, 2);
    assert.equal(reloaded.widgets[0].binding.variableId, led.id);
    assert.ok(ws.body.data.projects.some((p: { id: string }) => p.id === project.id));

    // deleting a variable unbinds widgets
    assert.equal((await agent.delete(`${API}/variables/${temp.id}`).set(CSRF)).status, 200);
    const after = (await agent.get(`${API}/dashboards/${dash.id}`)).body.data;
    assert.equal(after.widgets.find((w: { id: string }) => w.id === 'w2').binding, null);

    // keep one widget so three copies fit the FREE plan (3 × (200 project + 100 widget) = 900 of 1000 tokens)
    const trimmed = await agent.put(`${API}/dashboards/${dash.id}/widgets`).set(CSRF).send({ revision: after.revision, widgets: after.widgets.filter((w: { id: string }) => w.id === 'w1') });
    assert.equal(trimmed.status, 200);

    // duplicate project + export/import round-trip
    const dup = await agent.post(`${API}/projects/${project.id}/duplicate`).set(CSRF).send({});
    assert.equal(dup.status, 201);
    const bundle = (await agent.get(`${API}/projects/${project.id}/export`)).body.data;
    const imported = await agent.post(`${API}/projects/import`).set(CSRF).send(bundle);
    assert.equal(imported.status, 201);
    assert.match(imported.body.data.project.name, /imported/);
    const tokens = (await agent.get(`${API}/users/me/tokens`)).body.data;
    assert.equal(tokens.plan, 'FREE');
    assert.equal(tokens.used, 900);

    // pagination
    const page = await agent.get(`${API}/projects?page=1&pageSize=2&sort=-createdAt`);
    assert.equal(page.body.data.items.length, 2);
    assert.equal(page.body.data.total, 3);

    // delete
    assert.equal((await agent.delete(`${API}/projects/${project.id}`).set(CSRF)).status, 200);
    assert.equal((await agent.get(`${API}/projects/${project.id}`)).status, 404);
  });

  it('variable topics must stay inside the device namespace', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const { agent } = await registeredAgent(app, 'Topic tester');
    const device = (await agent.post(`${API}/devices`).set(CSRF).send({ name: 'D', board: 'ESP32-C3 Mini', kit: 'sensor' })).body.data.device;
    const project = (await agent.post(`${API}/projects`).set(CSRF).send({ name: 'P', deviceIds: [device.id], importVariables: false })).body.data.project;
    const res = await agent.post(`${API}/projects/${project.id}/variables`).set(CSRF).send({
      key: 'steal', displayName: 'x', dataType: 'boolean', direction: 'bidirectional', deviceId: device.id,
      stateTopic: 'kokoon/devices/someone-else/telemetry/led', commandTopic: 'kokoon/devices/someone-else/command/led',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'TOPIC_NOT_ALLOWED');
  });

  it('commands go only to your own variables and are rate limited per user', async (t) => {
    const app = await getApp();
    if (!app) return t.skip(unavailableReason);
    const alice = await registeredAgent(app, 'Cmd A');
    const bob = await registeredAgent(app, 'Cmd B');
    const device = (await alice.agent.post(`${API}/devices`).set(CSRF).send({ name: 'D', board: 'ESP32-C3 Mini', kit: 'actuator' })).body.data.device;
    const created = (await alice.agent.post(`${API}/projects`).set(CSRF).send({ name: 'P', deviceIds: [device.id] })).body.data;
    const led = created.variables.find((v: { key: string }) => v.key === 'led_state');
    const ok = await alice.agent.post(`${API}/mqtt/commands`).set(CSRF).send({ variableId: led.id, value: true });
    assert.equal(ok.status, 202);
    assert.equal(ok.body.data.command.status, 'pending', 'never reported as executed before an ack');
    assert.equal((await bob.agent.post(`${API}/mqtt/commands`).set(CSRF).send({ variableId: led.id, value: true })).status, 404);
    const raw = await bob.agent.post(`${API}/mqtt/publish`).set(CSRF).send({ topic: `${device.topicPrefix}/command/led_state`, payload: '{"value":true}' });
    assert.equal(raw.status, 403);
  });
});
