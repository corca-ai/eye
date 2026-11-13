import { expect, it } from 'vitest';
import { database } from '../helpers/analytics-db.js';
import { rawRecords } from '../../src/analytics/raw.js';
import { BasinAnalytics } from '../../src/analytics/query.js';
import { settings } from '../../src/core/validation.js';
import type { ExposureEvent, GoalEvent } from '../../src/core/types.js';
const day = 86400000, now = 1_800_000_000_000;
const start = Math.floor(now / day) * day - 4 * day;
const config = settings({minHoldMs: 0, observationWindowMs: 7 * day, attributionWindowMs: 7 * day, attributionHalfLifeMs: 60 * day});
function exposure(id: string, experimentId = 'exp', armId = 'a'): ExposureEvent {
  return {kind: 'exposure', eventId: id, occurredAt: start, subject: {cid: 'browser'}, assignment: {assignmentId: id, experimentId, armId, generation: 1, policyRevision: 1, assignedAt: start - 1, probability: 1, settings: config}, sample: {sampleId: id, startAt: start}, attributionWindowMs: 7 * day};
}
function goal(id: string, value: number, at: number, goalId = 'purchase'): GoalEvent {
  return {kind: 'goal', eventId: id, occurredAt: at, goalId, subject: {cid: 'browser'}, value};
}
it('buckets attributed signed goals by occurrence even while observations remain open, retaining earlier exposure and cross-experiment splitting', async () => {
  const earned = start + 3 * day + 100;
  const events = [exposure('first'), exposure('other', 'other'), goal('purchase', 100, earned), goal('refund', -40, earned + 100, 'refund')];
  const records = events.flatMap(event => rawRecords({siteId: 'site', event, receivedAt: now - 1}));
  const db = database([...records, ...records]);
  try {
    const api = new BasinAnalytics({EYE_ANALYTICS_WAREHOUSE: `${'a'.repeat(32)}_eye-test`, EYE_ANALYTICS_TOKEN: 'test'}, 'site', db.request, () => now);
    const query = {experimentId: 'exp', from: start + 3 * day, to: now, bucketMs: day};
    const all = await api.rewardSeries(query);
    expect(all.rows).toHaveLength(1);
    expect(all.rows[0]).toMatchObject({bucketStart: start + 3 * day, armId: 'a', generation: 1, goals: 2});
    const expected = 50 * 2 ** (-(earned - start) / config.attributionHalfLifeMs) - 20 * 2 ** (-(earned + 100 - start) / config.attributionHalfLifeMs);
    expect(all.rows[0]!.totalValue).toBeCloseTo(expected);
    const refund = await api.rewardSeries({...query, goalId: 'refund'});
    expect(refund.rows[0]!.goals).toBe(1);
    expect(refund.rows[0]!.totalValue).toBeLessThan(0);
    expect((await api.rewardSeries({...query, generation: 2})).rows).toEqual([]);
  } finally {db.close();}
});
it('validates buckets and time ranges before executing SQL', async () => {
  const api = new BasinAnalytics({EYE_ANALYTICS_WAREHOUSE: `${'a'.repeat(32)}_eye-test`, EYE_ANALYTICS_TOKEN: 'test'}, 'site', async () => {throw new Error('Must not execute');}, () => now);
  await expect(api.rewardSeries({experimentId: 'exp', from: start, to: now, bucketMs: 0})).rejects.toMatchObject({code: 'invalid_input'});
  await expect(api.rewardSeries({experimentId: 'exp', from: start, to: now + 1, bucketMs: day})).rejects.toMatchObject({code: 'outside_retention'});
});
it('keeps valid occurrence-time attribution after observation end rather than dropping it from the activity view', async () => {
  const initial = exposure('short');
  const shown: ExposureEvent = {...initial, assignment: {...initial.assignment, settings: {...config, observationWindowMs: 3600000}}};
  const earned = goal('later-goal', 100, start + 3 * day);
  const db = database([shown, earned].flatMap(event => rawRecords({siteId: 'site', event, receivedAt: now - 1})));
  try {
    const api = new BasinAnalytics({EYE_ANALYTICS_WAREHOUSE: `${'a'.repeat(32)}_eye-test`, EYE_ANALYTICS_TOKEN: 'test'}, 'site', db.request, () => now);
    const result = await api.rewardSeries({experimentId: 'exp', from: start + 3 * day, to: now, bucketMs: day});
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.goals).toBe(1);
    expect(result.rows[0]!.totalValue).toBeGreaterThan(0);
  } finally {db.close();}
});
