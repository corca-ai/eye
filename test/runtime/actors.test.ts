import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { experimentKey } from '../../src/core/validation.js';
import { addSample, emptyMoments } from '../../src/core/moments.js';

it('applies aggregate cohorts once across concurrent retries and eviction without user/reservation tables', async () => {
  const stub = env.EXPERIMENTS.getByName(experimentKey(crypto.randomUUID(), 'exp'));
  await stub.create({ experimentId: 'exp', arms: ['a', 'b'], settings: { minHoldMs: 0 } });
  const at = Date.now(), cohort = { cohortId: 'closing-hour/page', asOf: at,
    arms: [{ experimentId: 'exp', armId: 'a', generation: 1, samples: 10, moments: addSample(emptyMoments(at), 10, 10) }] };
  expect((await Promise.all(Array.from({ length: 10 }, () => stub.applyCohort(cohort)))).filter(Boolean)).toHaveLength(1);
  await evictDurableObject(stub);
  expect(await stub.applyCohort(cohort)).toBe(false);
  const policy = await stub.getPolicy();
  expect(policy.arms[0]!.weight).toBeCloseTo(10, 3);
  expect(policy.arms[0]!.meanReward).toBe(10);
  await runInDurableObject(stub, (_actor, state) => {
    const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map(r => r.name);
    expect(tables).not.toContain('reservations'); expect(tables).not.toContain('observations');
  });
});
it('arm addition and stop preserve accumulated evidence for ongoing experiments', async () => {
  const stub = env.EXPERIMENTS.getByName(crypto.randomUUID());
  await stub.create({ experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0 } });
  const at = Date.now();
  await stub.applyCohort({ cohortId: 'one', asOf: at, arms: [{ experimentId: 'exp', armId: 'a', generation: 1, samples: 100, moments: addSample(emptyMoments(at), 10, 100) }] });
  await stub.addArm('b');
  const policy = await stub.getPolicy();
  expect(policy.arms.find(a => a.armId === 'a')!.meanReward).toBe(10);
  expect(policy.arms.find(a => a.armId === 'b')!.probability).toBeCloseTo(0.2);
  await stub.setArmStatus('a', 'paused'); expect((await stub.getPolicy()).arms.map(a => a.armId)).toEqual(['b']);
  await stub.setArmStatus('a', 'active'); expect((await stub.getPolicy()).arms.find(a => a.armId === 'a')!.weight).toBeGreaterThan(99);
  await stub.setStatus('paused'); expect((await stub.getPolicy()).arms).toEqual([]);
});
it('validates cohort input atomically without poisoning the retry ID', async () => {
  const stub = env.EXPERIMENTS.getByName(crypto.randomUUID());
  await stub.create({ experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0 } });
  await runInDurableObject(stub, actor => {
    const at = Date.now(), valid = { experimentId: 'exp', armId: 'a', generation: 1, samples: 1, moments: addSample(emptyMoments(at), 1) };
    expect(() => actor.applyCohort({ cohortId: 'retry', asOf: at, arms: [valid, { ...valid, armId: 'missing' }] })).toThrow();
    expect(actor.applyCohort({ cohortId: 'retry', asOf: at, arms: [valid] })).toBe(true);
    expect(actor.getPolicy().arms[0]!.weight).toBeCloseTo(1, 3);
  });
});
it('reuses policy publication until aging, invalidates on new learning/config, and retains the learning timestamp', async () => {
  const { vi } = await import('vitest');
  const stub = env.EXPERIMENTS.getByName(crypto.randomUUID());
  await stub.create({ experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0 } });
  await runInDurableObject(stub, async actor => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const first = await actor.publishedPolicy();
      now += 20 * 60_000;
      expect((await actor.publishedPolicy()).sequence).toBe(first.sequence);
      const asOf = now;
      const arms = [{ experimentId: 'exp', armId: 'a', generation: 1, samples: 10, moments: addSample(emptyMoments(asOf), 50, 10) }];
      actor.applyCohort({ cohortId: 'one', asOf, arms });
      const learned = await actor.publishedPolicy();
      expect(learned.sequence).toBe(first.sequence + 1); expect(learned.statsAsOf).toBe(asOf);
      actor.applyCohort({ cohortId: 'two', asOf, arms });
      expect((await actor.publishedPolicy()).sequence).toBe(learned.sequence + 1);
      now += 3_600_001;
      const aged = await actor.publishedPolicy();
      expect(aged.sequence).toBe(learned.sequence + 2); expect(aged.statsAsOf).toBe(asOf);
      actor.addArm('b'); expect((await actor.publishedPolicy()).activeArms).toEqual(['a', 'b']);
      now += 1001;
      expect((await actor.publishedPolicy(undefined, 1000)).sequence).toBe(aged.sequence + 2);
    } finally { clock.mockRestore(); }
  });
});
