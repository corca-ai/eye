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
