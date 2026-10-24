import { expect, it } from 'vitest';
import { database } from '../helpers/analytics-db.js';
import { BasinAnalytics } from '../../src/analytics/query.js';
import { rawRecords } from '../../src/analytics/raw.js';
import { exportRecords } from '../../src/analytics/export.js';
import { reduceLearningPage } from '../../src/runtime/learning.js';
import { settings } from '../../src/core/validation.js';
import type { EyeEvent, ExposureEvent, GoalEvent } from '../../src/core/types.js';
const now = 1_800_000_000_000, start = now - 10000;
const env = { EYE_ANALYTICS_WAREHOUSE: `${'a'.repeat(32)}_eye-data`, EYE_ANALYTICS_TOKEN: 'test' };
const setting = settings({ minHoldMs: 0, observationWindowMs: 1000, allowedLatenessMs: 0, attributionHalfLifeMs: 100 });
function exposure(eventId: string, cid: string, experimentId = 'exp', at = start): ExposureEvent {
  return { kind: 'exposure', eventId, occurredAt: at, subject: { cid },
    assignment: { assignmentId: eventId, experimentId, armId: 'a', generation: 1, policyRevision: 1, assignedAt: start - 1, probability: 1, settings: setting },
    sample: { sampleId: eventId, startAt: at }, attributionWindowMs: 5000, userAttributes: { country: 'KR' } };
}
const goal = (eventId: string, at: number, value: number, cid = 'paid', uid?: string): GoalEvent => ({ kind: 'goal', eventId,
  goalId: 'purchase', occurredAt: at, subject: { cid, ...(uid === undefined ? {} : { uid }) }, value });
function fixture(initial: EyeEvent[], later: EyeEvent[] = []) {
  const ids = initial.filter((e): e is ExposureEvent => e.kind === 'exposure').map(e => e.sample!.sampleId);
  const closed = reduceLearningPage('site', 'batch', start + 1000, start + 2000, ids, initial, null, start + 2000);
  const rows = [...initial, ...later].flatMap(event => rawRecords({ siteId: 'site', receivedAt: now - 1, event }));
  const db = database(exportRecords([...rows, ...closed.records].map(record => ({ record }))));
  return { db, api: new BasinAnalytics(env, 'site', db.request, () => now), closed };
}
it('computes live rewards with the same decay as learning while exposing their later divergence', async () => {
  const f = fixture([exposure('paid-sample', 'paid'), exposure('zero-sample', 'zero'), goal('g1', start + 100, 100)], [goal('late', start + 200, 20)]);
  try {
    const report = await f.api.arms({ from: start, to: now, experimentId: 'exp', groupBy: [{ key: 'country', type: 'string' }] });
    expect(report.rewardBasis).toBe('raw_attribution');
    expect(report.rows[0]).toMatchObject({ completed: 2, totalValue: 55, learningValue: 50, meanValue: 27.5, groups: ['KR'] });
    const traffic = await f.api.traffic({ from: start - 2, to: now, experimentId: 'exp', bucketMs: 60000 });
    expect(traffic.rows.reduce((n, r) => n + r.exposures, 0)).toBe(2);
    expect(traffic.rows.reduce((n, r) => n + r.assignments, 0)).toBe(2);
    expect((await f.api.attributeKeys({ from: start, to: now })).rows).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'country', source: 'user' })]));
  } finally { f.db.close(); }
});
it('splits before learning eligibility, and reports outside-window credits without changing frozen learning', async () => {
  const e1 = exposure('early', 'paid'), e2 = exposure('later', 'paid', 'other', start + 500);
  const f = fixture([e1, e2, goal('inside', start + 600, 100)], [goal('outside-first', start + 1200, 100)]);
  try {
    const early = await f.api.arms({ from: start, to: now, experimentId: 'exp' });
    expect(early.rows[0]!.totalValue).toBeCloseTo(50 * 2 ** -6);
    const later = await f.api.arms({ from: start, to: now, experimentId: 'other' });
    expect(later.rows[0]!.totalValue).toBeCloseTo(50 * 2 ** -1 + 50 * 2 ** -7);
    const timeline = await f.api.timeline({ from: start, to: now, subject: { cid: 'paid' }, limit: 100 });
    expect(timeline.rows.some(r => r.table === 'credits' && r.experimentId === 'exp' && r.status === 'outside_observation')).toBe(true);
  } finally { f.db.close(); }
});
it('uses first-login ownership for live rewards, post-login event cohorts and uid timelines without account merging', async () => {
  const initial: EyeEvent[] = [exposure('anon', 'paid'),
    { kind: 'identify', eventId: 'login-a', occurredAt: start + 50, subject: { cid: 'paid', uid: 'a' } },
    goal('g-a', start + 100, 100, 'second-device', 'a'),
    { kind: 'track', eventId: 'track-a', name: 'read', occurredAt: start + 110, subject: { cid: 'paid', uid: 'a' } },
    { kind: 'logout', eventId: 'logout', occurredAt: start + 200, subject: { cid: 'paid' } },
    { kind: 'track', eventId: 'other-anon', name: 'other', occurredAt: start + 250, subject: { cid: 'paid' } },
    { kind: 'identify', eventId: 'login-b', occurredAt: start + 300, subject: { cid: 'paid', uid: 'b' } },
    goal('g-b', start + 400, 1e6, 'paid', 'b')];
  const f = fixture(initial);
  try {
    const report = await f.api.arms({ from: start, to: now, experimentId: 'exp', hasEvent: { name: 'read' } });
    expect(report.rows[0]).toMatchObject({ completed: 1, totalValue: 50, learningValue: 50 });
    expect((await f.api.arms({ from: start, to: now, experimentId: 'exp', hasEvent: { name: 'other' } })).rows).toEqual([]);
    const records = []; let cursor: string | undefined;
    do {
      const page = await f.api.timeline({ from: start, to: now, subject: { uid: 'a' }, limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      records.push(...page.rows); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(records.some(r => r.table === 'events' && r.recordId === 'anon')).toBe(true);
    expect(records.some(r => r.recordId === 'g-b' || r.recordId === 'other-anon')).toBe(false);
    expect(new Set(records.map(r => `${r.table}/${r.recordId}`)).size).toBe(records.length);
  } finally { f.db.close(); }
});
