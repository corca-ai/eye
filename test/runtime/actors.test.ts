import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { ExperimentState } from '../../src/runtime/experiment-state.js';
import { addSample, emptyMoments } from '../../src/core/moments.js';

it('arm addition and stop preserve accumulated evidence for ongoing experiments', async () => {
  const stub = env.SITES.getByName(crypto.randomUUID());
  const siteId = crypto.randomUUID();
  await stub.createExperiment(siteId, { experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0 } });
  await runInDurableObject(stub, (_actor, state) => {
    const experiment = new ExperimentState(state.storage.sql, state.storage.kv, 'exp'), at = Date.now();
    state.storage.transactionSync(() => experiment.applyMoments({ asOf: at, arms: [{ experimentId: 'exp', armId: 'a', generation: 1, samples: 100, moments: addSample(emptyMoments(at), 10, 100) }] }));
    state.storage.transactionSync(() => experiment.addArm('b'));
    const policy = experiment.getPolicy();
    expect(policy.arms.find(a => a.armId === 'a')!.meanReward).toBe(10);
    expect(policy.arms.find(a => a.armId === 'b')!.probability).toBeCloseTo(0.2);
    experiment.setArmStatus('a', 'paused'); expect(experiment.getPolicy().arms.map(a => a.armId)).toEqual(['b']);
    experiment.setArmStatus('a', 'active'); expect(experiment.getPolicy().arms.find(a => a.armId === 'a')!.weight).toBeGreaterThan(99);
    experiment.setStatus('paused'); expect(experiment.getPolicy().arms).toEqual([]);
  });
});
it('rolls back all moment updates when any arm is invalid', async () => {
  const stub = env.SITES.getByName(crypto.randomUUID());
  const siteId = crypto.randomUUID();
  await stub.createExperiment(siteId, { experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0 } });
  await runInDurableObject(stub, (_actor, state) => {
    const actor = new ExperimentState(state.storage.sql, state.storage.kv, 'exp');
    const at = Date.now(), valid = { experimentId: 'exp', armId: 'a', generation: 1, samples: 1, moments: addSample(emptyMoments(at), 1) };
    expect(() => state.storage.transactionSync(() => actor.applyMoments({ asOf: at, arms: [valid, { ...valid, armId: 'missing' }] }))).toThrow();
    expect(actor.getPolicy().arms[0]!.weight).toBe(0);
    state.storage.transactionSync(() => actor.applyMoments({ asOf: at, arms: [valid] }));
    expect(actor.getPolicy().arms[0]!.weight).toBeCloseTo(1, 3);
  });
});
it('reuses policy publication until aging, invalidates on new learning/config, and retains the learning timestamp', async () => {
  const { vi } = await import('vitest');
  const stub = env.SITES.getByName(crypto.randomUUID());
  const siteId = crypto.randomUUID();
  await stub.createExperiment(siteId, { experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0 } });
  await runInDurableObject(stub, async (actor, state) => {
    const experiment = new ExperimentState(state.storage.sql, state.storage.kv, 'exp');
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const first = await actor.publishedPolicy(siteId, 'exp');
      now += 20 * 60_000;
      expect((await actor.publishedPolicy(siteId, 'exp')).sequence).toBe(first.sequence);
      const asOf = now;
      const arms = [{ experimentId: 'exp', armId: 'a', generation: 1, samples: 10, moments: addSample(emptyMoments(asOf), 50, 10) }];
      state.storage.transactionSync(() => experiment.applyMoments({ asOf, arms }));
      const learned = await actor.publishedPolicy(siteId, 'exp');
      expect(learned.sequence).toBe(first.sequence + 1); expect(learned.statsAsOf).toBe(asOf);
      state.storage.transactionSync(() => experiment.applyMoments({ asOf, arms }));
      expect((await actor.publishedPolicy(siteId, 'exp')).sequence).toBe(learned.sequence + 1);
      now += 3_600_001;
      const aged = await actor.publishedPolicy(siteId, 'exp');
      expect(aged.sequence).toBe(learned.sequence + 2); expect(aged.statsAsOf).toBe(asOf);
      actor.addExperimentArm(siteId, 'exp', 'b'); expect((await actor.publishedPolicy(siteId, 'exp')).activeArms).toEqual(['a', 'b']);
      now += 1001;
      expect((await actor.publishedPolicy(siteId, 'exp', 1000)).sequence).toBe(aged.sequence + 2);
    } finally { clock.mockRestore(); }
  });
});
