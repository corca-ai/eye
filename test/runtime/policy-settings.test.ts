import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { ExperimentState } from '../../src/runtime/experiment-state.js';
import { addSample, emptyMoments } from '../../src/core/moments.js';
import type { ExperimentSettings, ExposureEvent } from '../../src/core/types.js';

const changes = {
  bootstrapShare: 0.3, bootstrapQuota: 12, explorationFloor: 0.1,
  rewardScale: 10, bonusMultiplier: 3,
  minHoldMs: 100, observationWindowMs: 2000, attributionWindowMs: 3000,
  attributionHalfLifeMs: 4000, learningHalfLifeMs: 5000,
} satisfies Record<keyof ExperimentSettings, number>;
const compatible = new Set<keyof ExperimentSettings>([
  'bootstrapShare', 'bootstrapQuota', 'explorationFloor', 'rewardScale', 'bonusMultiplier',
]);

it.each(Object.entries(changes))('classifies %s changes while preserving historical generation settings', async (key, value) => {
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId), at = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  try {
    const original = await site.createExperiment(siteId, { experimentId: 'exp', arms: ['a', 'b'], settings: { minHoldMs: 0 } });
    await runInDurableObject(site, (_actor, state) => {
      const experiment = new ExperimentState(state.storage.sql, state.storage.kv, 'exp');
      state.storage.transactionSync(() => experiment.applyMoments({ asOf: at, arms: [{ experimentId: 'exp',
        generation: 1, armId: 'a', samples: 100, moments: addSample(emptyMoments(at), 10, 100) }] }));
      const before = experiment.publish(siteId, 60_000);
      const next = state.storage.transactionSync(() => experiment.updateSettings({ [key]: value }));
      const generation = compatible.has(key as keyof ExperimentSettings) ? 1 : 2;
      expect(next.generation).toBe(generation);
      expect(next.revision).toBe(2);
      expect(experiment.getGeneration(1)).toEqual(original.settings);
      const after = experiment.publish(siteId, 60_000);
      expect(after.sequence).toBe(before.sequence + 1);
      expect(after.settings[key as keyof ExperimentSettings]).toBe(value);
      expect(after.arms[0]!.weight).toBe(generation === 1 ? 100 : 0);
      expect(experiment.updateSettings({ [key]: value })).toEqual(next);
      expect(experiment.publish(siteId, 60_000).sequence).toBe(after.sequence);
      const mixed = experiment.updateSettings({ bonusMultiplier: 4, observationWindowMs: 6000 });
      expect(mixed.generation).toBe(generation + 1);
      expect(mixed.revision).toBe(3);
    });
  } finally { clock.mockRestore(); }
});

it('closes in-flight samples into their original compatible or isolated generation', async () => {
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId), at = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  const send = vi.spyOn(env.ANALYTICS, 'send').mockResolvedValue(undefined);
  try {
    const first = await site.createExperiment(siteId, { experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0, observationWindowMs: 1000 } });
    const expose = (name: string, config: typeof first): ExposureEvent => ({ kind: 'exposure', eventId: name,
      subject: { cid: name }, occurredAt: at, assignment: { assignmentId: name, experimentId: 'exp', armId: 'a',
        generation: config.generation, policyRevision: config.revision, assignedAt: at, probability: 1, settings: config.settings },
      sample: { sampleId: name, startAt: at }, attributionWindowMs: 1000 });
    const old = expose('old', first);
    expect(await site.consumeLearning(siteId, [old])).toEqual([true]);
    const compatible = await site.updateExperiment(siteId, 'exp', { explorationFloor: 0.1 });
    expect(compatible.generation).toBe(first.generation);
    expect(await site.consumeLearning(siteId, [expose('compatible', compatible)])).toEqual([true]);
    const reset = await site.updateExperiment(siteId, 'exp', { observationWindowMs: 2000 });
    expect(await site.consumeLearning(siteId, [expose('new', reset)])).toEqual([true]);
    expect(old.assignment.settings).toEqual(first.settings);
    clock.mockReturnValue(at + 63_000);
    await runInDurableObject(site, async (actor, state) => {
      await actor.alarm();
      const rows = state.storage.sql.exec<{ generation: number; data: string }>(
        'SELECT generation, data FROM local_arm_moments ORDER BY generation').toArray();
      expect(rows.map(r => r.generation)).toEqual([1, 2]);
      expect(JSON.parse(rows[0]!.data).weight).toBeCloseTo(2 * 2 ** (-62_000 / first.settings.learningHalfLifeMs), 10);
      expect(JSON.parse(rows[1]!.data).weight).toBeCloseTo(2 ** (-61_000 / reset.settings.learningHalfLifeMs), 10);
      expect(actor.getExperimentPolicy(siteId, 'exp').arms[0]!.weight).toBeCloseTo(JSON.parse(rows[1]!.data).weight, 10);
    });
  } finally { clock.mockRestore(); send.mockRestore(); }
});
