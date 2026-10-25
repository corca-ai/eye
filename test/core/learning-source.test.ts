import { expect, it } from 'vitest';
import { database } from '../helpers/analytics-db.js';
import { LearningSource } from '../../benchmarks/sdk/legacy-learning.js';
import { rawRecords } from '../../src/analytics/raw.js';
import { settings } from '../../src/core/validation.js';
import type { EventEnvelope, ExposureEvent, GoalEvent, IdentityEvent } from '../../src/core/types.js';
const now = 1_800_000_000_000;
const env = { EYE_ANALYTICS_WAREHOUSE: `${'a'.repeat(32)}_eye-data`, EYE_ANALYTICS_TOKEN: 'test' };
const config = settings({ minHoldMs: 0, observationWindowMs: 1000, allowedLatenessMs: 10, attributionHalfLifeMs: 1000 });
const exposure: ExposureEvent = { kind: 'exposure', eventId: 'first', occurredAt: now - 3000, subject: { cid: 'browser' },
  assignment: { assignmentId: 'assignment', experimentId: 'exp', armId: 'a', generation: 1, assignedAt: now - 3100,
    policyRevision: 1, probability: 1, settings: config }, sample: { sampleId: 'sample', startAt: now - 3000 }, attributionWindowMs: 1000 };
const identity: IdentityEvent = { kind: 'identify', eventId: 'login', occurredAt: now - 2800, subject: { cid: 'browser', uid: 'user' } };
const goal: GoalEvent = { kind: 'goal', eventId: 'purchase', occurredAt: now - 2500, subject: { cid: 'other-device', uid: 'user' }, goalId: 'paid', value: 100 };
function envelope(event: EventEnvelope['event'], receivedAt = now - 1, siteId = 'site'): EventEnvelope { return { siteId, event, receivedAt }; }

it('executes bounded learner SQL against raw events, deduplicates retries, and joins anonymous exposure to another-device purchase', async () => {
  const rows = [exposure, identity, goal, goal].flatMap(e => rawRecords(envelope(e)));
  rows.push(...rawRecords(envelope({ ...goal, eventId: 'alien', value: 1e9 }, now - 1, 'other-site')));
  const db = database(rows);
  try {
    const source = new LearningSource(env, 'site', { windowMs: 1000, graceMs: 10, attributionMs: 1000 }, db.request, () => now);
    const page = await source.page(now - 2100, now - 1000, '');
    expect(page.next).toBeNull(); expect(page.cohort.samples).toHaveLength(1);
    expect(page.cohort.samples[0]!.reward).toBeCloseTo(100 * 2 ** -0.5);
    expect(page.records.find(r => r.table_name === 'observations')?.status).toBe('complete');
    // Per-goal attribution is queried from raw events; freeze only the sample total.
    expect(page.records.filter(r => r.table_name === 'credits')).toHaveLength(0);
    expect(page.records.find(r => r.table_name === 'observations')?.value).toBe(page.cohort.samples[0]!.reward);
  } finally { db.close(); }
});
it('paginates by logical sample ID and preserves zero rewards without including later-visible goals', async () => {
  const other = { ...exposure, eventId: 'other', subject: { cid: 'zero' }, sample: { sampleId: 'zero', startAt: exposure.occurredAt } };
  const rows = [exposure, other].flatMap(e => rawRecords(envelope(e)));
  rows.push(...rawRecords(envelope(identity)), ...rawRecords(envelope(goal, now + 1)));
  const db = database(rows);
  try {
    const source = new LearningSource(env, 'site', { windowMs: 1000, graceMs: 10, attributionMs: 1000 }, db.request, () => now);
    const first = await source.page(now - 2100, now - 1000, '', 1);
    const second = await source.page(now - 2100, now - 1000, first.next!, 1);
    expect(first.cohort.samples.map(s => s.sampleId)).toEqual(['sample']);
    expect(second.cohort.samples.map(s => s.sampleId)).toEqual(['zero']);
    expect(first.cohort.samples[0]!.reward).toBe(0); expect(second.cohort.samples[0]!.reward).toBe(0);
  } finally { db.close(); }
});

it.each(['arm', 'start', 'horizon'] as const)('rejects conflicting repeated sample %s before freezing a reward', async field => {
  const changed: ExposureEvent = { ...exposure, eventId: 'changed', occurredAt: exposure.occurredAt + 100,
    ...(field === 'arm' ? { assignment: { ...exposure.assignment, armId: 'b' } } : {}),
    ...(field === 'start' ? { sample: { sampleId: exposure.sample!.sampleId, startAt: exposure.sample!.startAt + 50 } } : {}),
    ...(field === 'horizon' ? { attributionWindowMs: 500 } : {}) };
  const db = database([exposure, changed, identity, goal].flatMap(event => rawRecords(envelope(event))));
  try {
    const source = new LearningSource(env, 'site', { windowMs: 1000, graceMs: 10, attributionMs: 1000 }, db.request, () => now);
    await expect(source.page(now - 2100, now - 1000, '')).rejects.toThrow('Conflicting sample context');
  } finally { db.close(); }
});
