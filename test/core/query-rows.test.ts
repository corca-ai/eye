import { expect, it } from 'vitest';
import { armRow, attributeKeyRow, eventListRow, policyRow, timelineRow } from '../../src/analytics/query-rows.js';
import { analyticsRecord } from '../../src/analytics/records.js';

const event = {
  ...analyticsRecord({ siteId: 'site', subjectKey: 'subject', cid: 'browser' }, 'events', 'event', 1, 100, 101, { kind: 'track' }),
  event_name: null, event_kind: 'track',
};

it('keeps lightweight and detailed event attributes consistent, without accepting nested or nonfinite values', () => {
  const row = { ...event, attributes_json: '{"locale":"ko","amount":-2,"enabled":true,"empty":null}' };
  const expected = { locale: 'ko', amount: -2, enabled: true, empty: null };
  expect(eventListRow(row).attributes).toEqual(expected);
  expect(timelineRow(row).attributes).toEqual(expected);
  for (const attributes_json of ['{"nested":{}}', '{"array":[]}', '{"n":1e999}', '[]', 'null', '{']) {
    for (const decode of [eventListRow, timelineRow]) {
      expect(() => decode({ ...event, attributes_json })).toThrow(expect.objectContaining({ code: 'unavailable' }));
    }
  }
});

it('distinguishes absent legacy allocation from an invalid allocation and preserves nullable arm averages', () => {
  const row = { arm_id: 'control', generation: 1, window_ms: 1000, completed: 0, pending: 1,
    subjects: 1, total_value: 0, learning_value: 0, mean_value: null, latest_received_at: 101,
    group_0: null, group_1: 'ko' };
  const groups = [{ key: 'plan', type: 'string' }, { key: 'locale', type: 'string' }] as const;
  expect(armRow(row, groups)).toMatchObject({ allocationMode: 'policy', meanValue: null, groups: [null, 'ko'] });
  expect(armRow({ ...row, allocation_mode: 'default', mean_value: -2 }, groups)).toMatchObject({ allocationMode: 'default', meanValue: -2 });
  expect(() => armRow({ ...row, allocation_mode: 'unknown' }, groups)).toThrow(expect.objectContaining({ code: 'unavailable' }));
  expect(() => armRow({ ...row, mean_value: Infinity }, groups)).toThrow(expect.objectContaining({ code: 'numeric_range' }));
});

it('validates policy payload fields and attribute discovery dimensions at the decoding boundary', () => {
  const policy = { ...event, arm_id: 'a', payload_json: JSON.stringify({ generation: 1, probability: 0,
    meanReward: null, score: null, scoreScale: 1, reason: 'published', status: 'paused' }) };
  expect(policyRow(policy)).toMatchObject({ probability: 0, meanReward: null, score: null, status: 'paused' });
  expect(() => policyRow({ ...policy, payload_json: '[]' })).toThrow(expect.objectContaining({ code: 'unavailable' }));
  expect(() => policyRow({ ...policy, payload_json: '{"generation":"1"}' })).toThrow(expect.objectContaining({ code: 'numeric_range' }));
  const attribute = { attribute_key: 'locale', attribute_type: 'string', attribute_source: 'user', latest_received_at: 101 };
  expect(attributeKeyRow(attribute)).toEqual({ key: 'locale', type: 'string', source: 'user', latestReceivedAt: 101 });
  expect(() => attributeKeyRow({ ...attribute, attribute_type: 'object' })).toThrow(expect.objectContaining({ code: 'unavailable' }));
  expect(() => attributeKeyRow({ ...attribute, attribute_source: 'unknown' })).toThrow(expect.objectContaining({ code: 'unavailable' }));
});
