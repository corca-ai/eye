import { afterAll, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { reduceClosedCohort } from '../../src/core/closed-cohort.js';
import type { IdentityEvent } from '../../src/core/types.js';
import { HOUR, simulate, store, type StreamBatch } from '../helpers/engine-stream.js';

const seeds = Array.from({ length: 8 }, (_, i) => i + 1);
const report: Record<string, unknown> = {};
const share = (counts: { a: number; b: number }, arm: 'a' | 'b') => counts[arm] / (counts.a + counts.b);
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const metrics = (runs: ReturnType<typeof simulate>[]) => ({ seeds: runs.map(run => run.seed),
  visits: runs.reduce((n, run) => n + run.samples, 0), events: runs.reduce((n, run) => n + run.uniqueEvents, 0),
  duplicateDeliveries: runs.reduce((n, run) => n + run.duplicates, 0), delayedEvents: runs.reduce((n, run) => n + run.delayed, 0),
  zeroSamples: runs.reduce((n, run) => n + run.zeroSamples, 0), refunds: runs.reduce((n, run) => n + run.refunds, 0),
  diagnostics: runs.reduce((sum, run) => ({ staleExposures: sum.staleExposures + run.diagnostics.staleExposures,
    staleIdentities: sum.staleIdentities + run.diagnostics.staleIdentities, futureExposures: sum.futureExposures + run.diagnostics.futureExposures,
    closedGoals: sum.closedGoals + run.diagnostics.closedGoals }), { staleExposures: 0, staleIdentities: 0, futureExposures: 0, closedGoals: 0 }),
  bShares: runs.map(run => share(run.counts, 'b')) });

it('fixed 50:50 A/A has balanced assignment and no systematic conversion difference', () => {
  const runs = seeds.map(seed => simulate({ seed, visits: 800, days: 4, kind: 'aa', uniform: true, capture: seed === seeds[0] }));
  const counts = { a: 0, b: 0 }, goals = { a: 0, b: 0 };
  for (const run of runs) for (const arm of ['a', 'b'] as const) { counts[arm] += run.counts[arm]; goals[arm] += run.purchases[arm]; }
  const p = (goals.a + goals.b) / (counts.a + counts.b);
  const z = (goals.b / counts.b - goals.a / counts.a) / Math.sqrt(p * (1 - p) * (1 / counts.a + 1 / counts.b));
  expect(share(counts, 'b')).toBeGreaterThan(.47);
  expect(share(counts, 'b')).toBeLessThan(.53);
  expect(Math.abs(z)).toBeLessThan(3.29); // Fixed-horizon null sanity check, not an adaptive p-value.
  const rewards = { a: { sum: 0, squares: 0 }, b: { sum: 0, squares: 0 } };
  for (const run of runs) for (const arm of ['a', 'b'] as const) {
    rewards[arm].sum += run.credited[arm].sum; rewards[arm].squares += run.credited[arm].squares;
  }
  const variance = (arm: 'a' | 'b') => (rewards[arm].squares - rewards[arm].sum ** 2 / counts[arm]) / (counts[arm] - 1);
  const rewardMeans = { a: rewards.a.sum / counts.a, b: rewards.b.sum / counts.b };
  const rewardZ = (rewardMeans.b - rewardMeans.a) / Math.sqrt(variance('a') / counts.a + variance('b') / counts.b);
  expect(Math.abs(rewardZ)).toBeLessThan(3.29);
  report.fixedAA = { ...metrics(runs), counts, purchases: goals, z, rewardMeans, rewardZ, maxAbsZ: 3.29 };
  // Inspect the actual delivery order, including duplicates and delayed events.
  if (process.env.EYE_STREAM_LOG) writeFileSync(process.env.EYE_STREAM_LOG,
    runs[0]!.batches.flatMap(batch => batch.events.map(event => JSON.stringify({ siteId: 'site', receivedAt: batch.now, event }))).join('\n') + '\n');
}, 120_000);

it('adaptive A/A does not systematically prefer an arm across independent seeds', () => {
  const runs = seeds.map(seed => simulate({ seed, visits: 800, days: 4, kind: 'aa' }));
  const averageBShare = mean(runs.map(run => share(run.counts, 'b')));
  expect(averageBShare).toBeGreaterThan(.35);
  expect(averageBShare).toBeLessThan(.65);
  report.adaptiveAA = { ...metrics(runs), averageBShare, allowedMeanRange: [.35, .65] };
}, 120_000);

it('learns a known winner from sparse purchases and signed refunds', () => {
  const runs = [1, 2].map(seed => simulate({ seed, visits: 2000, days: 4, kind: 'ab' }));
  const lateWinnerShares = runs.map(run => share(run.phases[3]!, 'b'));
  expect(mean(lateWinnerShares)).toBeGreaterThan(.65);
  for (const run of runs) { expect(run.refunds).toBeGreaterThan(0); expect(run.zeroSamples).toBeGreaterThan(0); }
  report.knownWinner = { ...metrics(runs), lateWinnerShares, minimumMeanWinnerShare: .65 };
}, 120_000);

it('adapts after the formerly worse arm becomes the winner', () => {
  const runs = [1, 2].map(seed => simulate({ seed, visits: 3200, days: 8, kind: 'switch' }));
  const before = runs.map(run => share(run.phases[1]!, 'b')), after = runs.map(run => share(run.phases[3]!, 'a'));
  expect(mean(before)).toBeGreaterThan(.65);
  expect(mean(after)).toBeGreaterThan(.65);
  report.winnerSwitch = { ...metrics(runs), beforeWinnerShares: before, afterWinnerShares: after, minimumMeanWinnerShare: .65 };
}, 120_000);

function replay(batches: StreamBatch[], end: number, chunkSize: number, duplicate: boolean) {
  const { db, engine, atomic } = store(), observations = new Map<string, number>();
  const close = (now: number) => {
    atomic(() => { engine.prune(now); engine.close('site', now); });
    for (const { id, output } of engine.outputs()) {
      for (const row of output.records) { expect(observations.has(row.record_id)).toBe(false); observations.set(row.record_id, row.value!); }
      atomic(() => engine.acknowledge([id]));
    }
  };
  try {
    for (const batch of batches) {
      close(batch.now);
      for (let i = 0; i < batch.events.length; i += chunkSize) {
        const chunk = batch.events.slice(i, i + chunkSize);
        atomic(() => engine.accept(chunk, batch.now));
        if (duplicate) atomic(() => engine.accept(chunk, batch.now));
      }
    }
    close(end);
    return observations;
  } finally { db.close(); }
}

it('matches a raw-event reference and preserves rewards under chunking and redelivery', () => {
  const run = simulate({ seed: 17, visits: 240, days: 2, kind: 'ab', ordered: true, capture: true });
  const expected = reduceClosedCohort({ cohortId: 'reference', from: 0, until: run.end + HOUR, asOf: run.end + HOUR,
    exposures: run.events.filter(event => event.kind === 'exposure').map(event => ({ event, ...event.sample!, attributionWindowMs: event.attributionWindowMs! })),
    goals: run.events.filter(event => event.kind === 'goal'),
    identities: run.events.filter((event): event is IdentityEvent => event.kind === 'identify' || event.kind === 'logout') });
  expect(expected.samples).toHaveLength(run.samples);
  for (const sample of expected.samples) expect(run.observations.get(sample.sampleId)).toBeCloseTo(sample.reward, 10);
  for (const [chunkSize, duplicate] of [[1, false], [100, true]] as const) {
    const actual = replay(run.batches, run.end + HOUR, chunkSize, duplicate);
    expect(actual.size).toBe(run.samples);
    for (const [id, reward] of run.observations) expect(actual.get(id)).toBeCloseTo(reward, 10);
  }
  report.referenceAndReplay = { ...metrics([run]), matchedSamples: expected.samples.length, chunkSizes: [1, 100] };
}, 120_000);

it('changing reward units and rewardScale together preserves the learned decisions', () => {
  const base = simulate({ seed: 31, visits: 600, days: 3, kind: 'ab', ordered: true });
  const scaled = simulate({ seed: 31, visits: 600, days: 3, kind: 'ab', ordered: true, scale: 1000 });
  expect(scaled.selected).toEqual(base.selected);
  for (const [id, reward] of base.observations) expect(scaled.observations.get(id)! / 1000).toBeCloseTo(reward, 10);
  report.rewardUnits = { ...metrics([base, scaled]), visitsPerRun: base.samples, multiplier: 1000, identicalAssignments: true };
}, 120_000);

afterAll(() => {
  if (process.env.EYE_STREAM_REPORT && Object.keys(report).length === 6)
    writeFileSync(process.env.EYE_STREAM_REPORT, JSON.stringify(report, null, 2) + '\n');
});
