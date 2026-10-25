import { expect, it } from 'vitest';
import { closingSQL } from '../../benchmarks/sdk/legacy-learning-sql.js';
import { reduceClosedCohort } from '../../src/core/closed-cohort.js';
import { settings } from '../../src/core/validation.js';
import { rawRecords } from '../../src/analytics/raw.js';
import { database } from '../helpers/analytics-db.js';
import type { ExposureEvent, EyeEvent, IdentityEvent } from '../../src/core/types.js';
const now = 1_800_000_000_000;
const config = settings({ minHoldMs: 0, observationWindowMs: 1000, allowedLatenessMs: 10, attributionHalfLifeMs: 1000 });
const first: ExposureEvent = { kind: 'exposure', eventId: 'first', occurredAt: now - 3000, subject: { cid: 'browser' },
  assignment: { assignmentId: 'assignment', experimentId: 'exp', armId: 'a', generation: 1, assignedAt: now - 3100,
    policyRevision: 1, probability: 1, settings: config }, sample: { sampleId: 'sample', startAt: now - 3000 }, attributionWindowMs: 1000 };
const bounds = { windowMs: 1000, graceMs: 10, attributionMs: 1000 };
it('bulk rewards preserve login attribution, signed/zero rewards and cross-partition experiment denominators', () => {
  const competitor: ExposureEvent = { ...first, eventId: 'competing', assignment: { ...first.assignment, experimentId: 'exp2', assignmentId: 'other' }, sample: { sampleId: 'another', startAt: first.occurredAt } };
  const events: EyeEvent[] = [first, competitor,
    { ...first, eventId: 'zero', subject: { cid: 'zero' }, sample: { sampleId: 'zero', startAt: first.occurredAt } },
    { kind: 'identify', eventId: 'login', occurredAt: now - 2800, subject: { cid: 'browser', uid: 'user' } },
    { kind: 'goal', eventId: 'pay', occurredAt: now - 2500, subject: { cid: 'other-device', uid: 'user' }, goalId: 'pay', value: 100 },
    { kind: 'goal', eventId: 'refund', occurredAt: now - 2400, subject: { cid: 'other-device', uid: 'user' }, goalId: 'refund', value: -30 }];
  const db = database([...events, events[4]!].flatMap(event => rawRecords({ siteId: 'site', receivedAt: now - 1, event })));
  try {
    const expected = reduceClosedCohort({ cohortId: 'test', from: now - 2100, until: now - 1000, asOf: now - 1000,
      exposures: events.filter((e): e is ExposureEvent => e.kind === 'exposure').map(event => ({ event, ...event.sample!, attributionWindowMs: event.attributionWindowMs! })),
      goals: events.filter(e => e.kind === 'goal'), identities: events.filter((e): e is IdentityEvent => e.kind === 'identify' || e.kind === 'logout') });
    const query = (after: string, limit: number) => db.run(closingSQL('eye', 'site', now - 2100, now - 1000, after, limit, now, bounds));
    const all = query('', 1000);
    expect(all).toHaveLength(3);
    for (const sample of expected.samples) expect(all.find(r => r.observation_id === sample.sampleId)?.reward).toBeCloseTo(sample.reward);
    const partition = query('another', 1);
    expect(partition).toHaveLength(1);
    expect(partition[0]!.observation_id).toBe('sample');
    expect(partition[0]!.reward).toBe(all.find(r => r.observation_id === 'sample')!.reward);
    expect(query('sample', 1)[0]!.reward).toBe(0);
  } finally { db.close(); }
});
it('scales large signed credits before summing to avoid intermediate overflow', () => {
  const events: EyeEvent[] = [first, ...[1e308, 1e308, -1e308, -1e308].map((value, i) => ({ kind: 'goal' as const,
    eventId: `g${i}`, occurredAt: first.occurredAt, subject: first.subject, goalId: 'value', value }))];
  const db = database(events.flatMap(event => rawRecords({ siteId: 'site', receivedAt: now - 1, event })));
  try { expect(db.run(closingSQL('eye', 'site', now - 2100, now - 1000, '', 1000, now, bounds))[0]!.reward).toBe(0); }
  finally { db.close(); }
});
