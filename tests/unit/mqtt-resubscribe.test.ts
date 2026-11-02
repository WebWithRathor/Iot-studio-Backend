import '../helpers/test-env';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import mqttPacket from 'mqtt-packet';
import { MQTT_LIMITS } from '../../src/constants/mqtt.constants';
import { resubscribeAll } from '../../src/services/shared/mqtt-connection.service';
import { chunkSubscribeFilters, subscribePacketBytes } from '../../src/utils/mqtt-topic.util';

/** Same limit as docker/mosquitto/*.conf `max_packet_size`. */
const BROKER_MAX_PACKET = 8192;

/** Real wire size of a SUBSCRIBE (MQTT 3.1.1), via MQTT.js's own encoder. */
const wireBytes = (filters: readonly string[]) =>
  mqttPacket.generate({ cmd: 'subscribe', messageId: 1, subscriptions: filters.map((topic) => ({ topic, qos: 1 as const })) }, { protocolVersion: 4 }).length;

/** Mosquitto-like client: a SUBSCRIBE over max_packet_size drops the whole connection. */
function fakeClient() {
  const packets: string[][] = [];
  let dropped = false;
  const client = {
    subscribe(filters: string | string[], _opts: unknown, cb?: (err: Error | null) => void) {
      const list = Array.isArray(filters) ? filters : [filters];
      if (wireBytes(list) > BROKER_MAX_PACKET) {
        dropped = true;
        cb?.(new Error('connection closed by broker: packet too large'));
      } else {
        packets.push(list);
        cb?.(null);
      }
      return client;
    },
  };
  return { client, packets, dropped: () => dropped };
}

const filtersFor = (n: number, len: number) =>
  Array.from({ length: n }, (_, i) => `custom/${String(i).padStart(5, '0')}/${'x'.repeat(Math.max(0, len - 13))}`.slice(0, len));

describe('SUBSCRIBE packet sizing', () => {
  it('never under-counts the MQTT.js encoder (at most 3 bytes over, for the length header)', () => {
    for (const filters of [['a'], filtersFor(10, 200), filtersFor(300, 40)]) {
      const est = subscribePacketBytes(filters);
      const real = wireBytes(filters);
      assert.ok(est >= real && est - real <= 3, `estimate ${est} vs real ${real}`);
    }
  });

  it('chunks stay within the budget, keep order and lose nothing', () => {
    const filters = filtersFor(500, 200);
    const chunks = chunkSubscribeFilters(filters);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(wireBytes(c) <= MQTT_LIMITS.SUBSCRIBE_PACKET_MAX_BYTES, `chunk of ${c.length} is ${wireBytes(c)} bytes`);
    assert.deepEqual(chunks.flat(), filters);
  });

  it('few short filters go in one packet; none means no packet', () => {
    assert.deepEqual(chunkSubscribeFilters(['kokoon/devices/+/telemetry/+', 'kokoon/devices/+/availability']).length, 1);
    assert.deepEqual(chunkSubscribeFilters([]), []);
  });

  it('a filter bigger than the budget still gets its own chunk', () => {
    const big = 'y'.repeat(300);
    assert.deepEqual(chunkSubscribeFilters(['a', big, 'b'], 100), [['a'], [big], ['b']]);
  });
});

describe('resubscribeAll (reconnect path)', () => {
  it('a single packet with every filter would be dropped by the broker', () => {
    const f = fakeClient();
    f.client.subscribe(filtersFor(400, 200), { qos: 1 });
    assert.equal(f.dropped(), true);
  });

  it('resubscribes hundreds of long filters without exceeding max_packet_size', () => {
    const filters = ['kokoon/devices/+/telemetry/+', 'kokoon/devices/+/availability', 'kokoon/devices/+/ack/+', ...filtersFor(1000, 200)];
    const f = fakeClient();
    resubscribeAll(f.client, filters);
    assert.equal(f.dropped(), false);
    assert.ok(f.packets.length > 1);
    assert.deepEqual(f.packets.flat(), filters);
  });

  it('sends nothing when there are no filters', () => {
    const f = fakeClient();
    resubscribeAll(f.client, []);
    assert.equal(f.packets.length, 0);
  });
});
