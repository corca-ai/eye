import { describe, expect, it } from 'vitest';
import { reduceClosedCohort } from '../../src/core/closed-cohort.js';
import type { CohortInput, SampleExposure } from '../../src/core/closed-cohort.js';
import { meanOf, stddevOf } from '../../src/core/moments.js';
import type { Assignment, GoalEvent, Subject } from '../../src/core/types.js';
import { settings } from '../../src/core/validation.js';

const subject: Subject = { cid: 'browser' };
function exposure(id: string, experimentId: string, armId: string, at: number, options: {
  start?: number; sampleId?: string; assignmentId?: string; window?: number; lookback?: number; subject?: Subject;
} = {}): SampleExposure {
  const assignment: Assignment = { assignmentId: options.assignmentId ?? id, experimentId, armId,
    assignedAt: 0, generation: 1, policyRevision: 1, probability: 0.5,
    settings: settings({ minHoldMs: 0, observationWindowMs: options.window ?? 100,
      allowedLatenessMs: 10, attributionHalfLifeMs: 100, learningHalfLifeMs: 1000 }) };
  return { event: { kind: 'exposure', eventId: id, occurredAt: at, assignment, subject: options.subject ?? subject },
    sampleId: options.sampleId ?? id, startAt: options.start ?? at, attributionWindowMs: options.lookback ?? 100 };
}
const goal = (eventId: string, occurredAt: number, value: number, owner = subject): GoalEvent => ({
  kind: 'goal', eventId, occurredAt, value, subject: owner, goalId: 'purchase',
});
const input = (exposures: SampleExposure[], goals: GoalEvent[] = []): CohortInput => ({
  cohortId: 'site/closing-0/partition-1', from: 0, until: 200, asOf: 200, exposures, goals, identities: [],
});

describe('immutable closed-cohort reduction', () => {
  it('includes exposed zero outcomes, never manufactures unexposed samples, and ages from evaluation end', () => {
    const result = reduceClosedCohort(input([exposure('shown', 'e', 'a', 10)]));
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]!.reward).toBe(0);
    expect(result.arms[0]!.moments.weight).toBeCloseTo(2 ** (-90 / 1000), 12);
    expect(reduceClosedCohort(input([])).arms).toEqual([]);
  });

  it('keeps a forced-switch old sample to its original end without double-crediting', () => {
    const result = reduceClosedCohort(input([
      exposure('old', 'e', 'a', 10), exposure('new', 'e', 'b', 30),
    ], [goal('g1', 20, 10), goal('g2', 40, 20)]));
    const [old, next] = result.samples;
    expect(old!.endAt).toBe(110);
    expect(next!.endAt).toBe(130);
    expect(old!.reward).toBeCloseTo(10 * 2 ** -0.1, 12);
    expect(next!.reward).toBeCloseTo(20 * 2 ** -0.1, 12);
  });

  it('uses equal attribution eligibility before excluding closed learning windows', () => {
    const result = reduceClosedCohort(input([
      exposure('closed', 'e1', 'a', 0, { window: 20 }),
      exposure('open', 'e2', 'a', 10),
    ], [goal('g', 30, 100)]));
    expect(result.samples.find(s => s.sampleId === 'closed')!.reward).toBe(0);
    expect(result.samples.find(s => s.sampleId === 'open')!.reward).toBeCloseTo(50 * 2 ** -0.2, 12);
  });

  it('excludes expired attribution before splitting and never revives an older longer-lookback exposure', () => {
    const result = reduceClosedCohort(input([
      exposure('old', 'e1', 'a', 0, { lookback: 1000 }),
      exposure('latest', 'e1', 'b', 20, { lookback: 5 }),
      exposure('other', 'e2', 'a', 10),
    ], [goal('g', 30, 100)]));
    expect(result.samples.find(s => s.sampleId === 'other')!.reward).toBeCloseTo(100 * 2 ** -0.2, 12);
    expect(result.samples.filter(s => s.sampleId !== 'other').every(s => s.reward === 0)).toBe(true);
  });

  it('uses repeated actual exposures for decay without adding independent samples', () => {
    const result = reduceClosedCohort(input([
      exposure('first', 'e', 'a', 10),
      exposure('repeat', 'e', 'a', 30, { assignmentId: 'first', sampleId: 'first', start: 10 }),
    ], [goal('g', 40, -10)]));
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]!.reward).toBeCloseTo(-10 * 2 ** -0.1, 12);
    expect(result.arms[0]!.samples).toBe(1);
  });

  it('links anonymous exposure to the first login account across devices, excluding another account', () => {
    const base = input([exposure('first', 'e', 'a', 10)], [
      goal('a', 30, 10, { cid: 'other-device', uid: 'a' }),
      goal('b', 50, 1000, { cid: 'browser', uid: 'b' }),
    ]);
    const result = reduceClosedCohort({ ...base, identities: [
      { kind: 'identify', eventId: 'login-a', occurredAt: 20, subject: { cid: 'browser', uid: 'a' } },
      { kind: 'identify', eventId: 'login-b', occurredAt: 40, subject: { cid: 'browser', uid: 'b' } },
    ] });
    expect(result.samples[0]!.reward).toBeCloseTo(10 * 2 ** -0.2, 12);
  });

  it('assigns samples to one half-open closing cohort and retains other-cohort exposures in the split', () => {
    const base = input([exposure('early', 'e1', 'a', 10), exposure('later', 'e2', 'a', 20)], [goal('g', 30, 100)]);
    const first = reduceClosedCohort({ ...base, until: 130, asOf: 130 });
    const second = reduceClosedCohort({ ...base, cohortId: 'next', from: 130 });
    expect(first.samples.map(s => s.sampleId)).toEqual(['early']);
    expect(second.samples.map(s => s.sampleId)).toEqual(['later']);
    expect(first.samples[0]!.reward).toBeCloseTo(50 * 2 ** -0.2, 12);
    expect(second.samples[0]!.reward).toBeCloseTo(50 * 2 ** -0.1, 12);
  });

  it('calculates moments from per-sample totals including zeros, not individual goals', () => {
    const result = reduceClosedCohort(input([
      exposure('one', 'e', 'a', 10, { subject: { cid: 'one' } }),
      exposure('two', 'e', 'a', 10, { subject: { cid: 'two' } }),
    ], [goal('g1', 10, 1e300, { cid: 'one' }), goal('g2', 10, 1e300, { cid: 'one' })]));
    // At the same timestamp, IDs g1/g2 sort before 'one', so these goals cannot
    // use that future-in-order exposure. Use a later timestamp for reward checks.
    expect(result.samples.every(s => s.reward === 0)).toBe(true);
    const later = reduceClosedCohort(input([
      exposure('one', 'e', 'a', 10, { subject: { cid: 'one' } }),
      exposure('two', 'e', 'a', 10, { subject: { cid: 'two' } }),
    ], [goal('g1', 20, 1e300, { cid: 'one' }), goal('g2', 20, 1e300, { cid: 'one' })]));
    expect(meanOf(later.arms[0]!.moments) / 1e300).toBeCloseTo(2 ** -0.1, 12);
    expect(stddevOf(later.arms[0]!.moments) / 1e300).toBeCloseTo(2 ** -0.1, 12);
  });

  it('accepts a finite final signed sum even when intermediate totals exceed the numeric range', () => {
    const base = input([exposure('a', 'e', 'a', 10)], [
      goal('g0', 10, 1e308), goal('g1', 10, 1e308), goal('g2', 10, -1e308),
    ]);
    expect(reduceClosedCohort(base).samples[0]!.reward).toBe(1e308);
    expect(() => reduceClosedCohort({ ...base, goals: base.goals.slice(0, 2) })).toThrow(/finite numeric range/);
    const compensation = reduceClosedCohort({ ...base, goals: [
      goal('g0', 10, 1e20), goal('g1', 10, 1), goal('g2', 10, -1e20),
    ] });
    expect(compensation.samples[0]!.reward).toBe(1);
  });

  it('includes the exact attribution horizon but excludes the next millisecond', () => {
    const shown = exposure('a', 'e', 'a', 10, { lookback: 20 });
    const result = reduceClosedCohort(input([shown], [goal('g1', 30, 10), goal('g2', 31, 1000)]));
    expect(result.samples[0]!.reward).toBeCloseTo(10 * 2 ** -0.2, 12);
  });

  it('excludes goals exactly at evaluation end without reallocating their share', () => {
    const result = reduceClosedCohort(input([
      exposure('a', 'e1', 'a', 10, { window: 20 }), exposure('b', 'e2', 'a', 10),
    ], [goal('g', 30, 10)]));
    expect(result.samples[0]!.reward).toBe(0);
    expect(result.samples[1]!.reward).toBeCloseTo(5 * 2 ** -0.2, 12);
  });

  it('keeps an unrewarded forced-switch sample as zero through its original end', () => {
    const result = reduceClosedCohort(input([
      exposure('a', 'e', 'a', 10), exposure('b', 'e', 'b', 20),
    ], [goal('g', 30, 10)]));
    expect(result.samples[0]).toMatchObject({ startAt: 10, endAt: 110, reward: 0 });
    expect(result.arms.find(a => a.armId === 'a')!.samples).toBe(1);
  });

  it('rejects duplicate events and conflicting sample contexts instead of silently double-counting', () => {
    const shown = exposure('shown', 'e', 'a', 10);
    expect(() => reduceClosedCohort(input([shown, shown]))).toThrow(/Deduplicate/);
    expect(() => reduceClosedCohort(input([shown, exposure('another', 'e', 'b', 20, { sampleId: 'shown' })]))).toThrow(/Conflicting/);
    expect(() => reduceClosedCohort(input([shown], [goal('g', 20, 1), goal('g', 20, 1)]))).toThrow(/Deduplicate/);
  });
});
