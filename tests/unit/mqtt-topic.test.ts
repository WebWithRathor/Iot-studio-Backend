import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ackTopicFor, classifyDeviceTopic, coerceCommandValue, commandTopicForAck, decodeValue, encodeValue, isUnderPrefix, suggestTopics, topicMatches, validatePayload, validateTopic,
} from '../../src/utils/mqtt-topic.util';

const P = 'kokoon/devices/esp32-bench-a1b2';

describe('topic validation', () => {
  it('accepts normal topics', () => assert.equal(validateTopic(`${P}/command/led_state`), null));
  it('rejects wildcards, spaces, empty levels, $-topics and leading slashes', () => {
    for (const t of ['a/+/b', 'a/#', 'a b', 'a//b', '/a', 'a/', '$SYS/x', 'a/ü']) assert.notEqual(validateTopic(t), null, t);
  });
  it('limits length and depth', () => {
    assert.notEqual(validateTopic('a/'.repeat(11) + 'z'), null);
    assert.notEqual(validateTopic('x'.repeat(201)), null);
  });
});

describe('topic matching and namespaces', () => {
  it('supports + and #', () => {
    assert.ok(topicMatches('kokoon/devices/+/telemetry/+', `${P}/telemetry/temperature`));
    assert.ok(!topicMatches('kokoon/devices/+/telemetry/+', `${P}/command/x`));
    assert.ok(topicMatches('kokoon/#', `${P}/availability`));
    assert.ok(!topicMatches('#', '$SYS/broker'));
  });
  it('isUnderPrefix does not match look-alike siblings', () => {
    assert.ok(isUnderPrefix(`${P}/command/x`, P));
    assert.ok(!isUnderPrefix(`${P}-evil/command/x`, P), 'esp32-bench-a1b2-evil must not count as inside esp32-bench-a1b2');
    assert.ok(!isUnderPrefix(P, P));
  });
  it('classifies device topics', () => {
    assert.deepEqual(classifyDeviceTopic(`${P}/telemetry/temp`, P), { kind: 'telemetry', key: 'temp' });
    assert.deepEqual(classifyDeviceTopic(`${P}/availability`, P), { kind: 'availability' });
    assert.deepEqual(classifyDeviceTopic(`${P}/sensors/x/ack`, P), { kind: 'ack' });
    assert.equal(classifyDeviceTopic('other/topic', P), null);
  });
  it('maps commands to ack topics and back', () => {
    assert.equal(ackTopicFor(`${P}/command/led_state`, P), `${P}/ack/led_state`);
    assert.equal(commandTopicForAck(`${P}/ack/led_state`, P), `${P}/command/led_state`);
    assert.equal(ackTopicFor(`${P}/custom/relay`, P), `${P}/custom/relay/ack`);
    assert.equal(commandTopicForAck(`${P}/custom/relay/ack`, P), `${P}/custom/relay`);
  });
  it('suggests topics by direction', () => {
    assert.deepEqual(suggestTopics(P, 'temperature', 'telemetry'), { stateTopic: `${P}/telemetry/temperature`, commandTopic: undefined });
    assert.deepEqual(suggestTopics(P, 'buzzer', 'command'), { stateTopic: undefined, commandTopic: `${P}/command/buzzer` });
  });
});

describe('payloads and values', () => {
  it('round-trips {"value": x}', () => {
    assert.equal(decodeValue(encodeValue(27.4, '°C')), 27.4);
    assert.equal(decodeValue('not json'), 'not json');
  });
  it('rejects oversized, deeply nested or control-character payloads', () => {
    assert.notEqual(validatePayload('x'.repeat(5000)), null);
    assert.notEqual(validatePayload(JSON.stringify({ a: { b: { c: { d: { e: 1 } } } } })), null);
    assert.notEqual(validatePayload('a\u0001b'), null);
    assert.equal(validatePayload('{"value":true}'), null);
  });
  it('coerces command values strictly by data type and range', () => {
    assert.deepEqual(coerceCommandValue('true', 'boolean'), { value: true });
    assert.ok(coerceCommandValue('maybe', 'boolean').error);
    assert.deepEqual(coerceCommandValue('12.7', 'integer', { min: 0, max: 255 }), { value: 13 });
    assert.ok(coerceCommandValue(300, 'integer', { min: 0, max: 255 }).error);
    assert.deepEqual(coerceCommandValue('#AABBCC', 'color'), { value: '#aabbcc' });
    assert.ok(coerceCommandValue('red', 'color').error);
    assert.ok(coerceCommandValue('x'.repeat(300), 'string').error);
  });
});
