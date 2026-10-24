import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { LearningSource, COHORT_INTERVAL_MS } from '../../src/runtime/learning.js';
import { experimentKey } from '../../src/core/validation.js';
import { addSample, emptyMoments } from '../../src/core/moments.js';

it('freezes the first closing result, retries export after eviction, and never applies new query data twice', async () => {
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId), experiment = env.EXPERIMENTS.getByName(experimentKey(siteId, 'exp'));
  const config = await experiment.create({ experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0 } });
  await site.registerExperiment('exp', siteId, config.settings);
  const until = Math.floor(Date.now() / COHORT_INTERVAL_MS) * COHORT_INTERVAL_MS, from = until - COHORT_INTERVAL_MS;
  const cohortId = JSON.stringify([siteId, from, until, '']);
  const page = vi.spyOn(LearningSource.prototype, 'page').mockResolvedValue({
    cohort: { cohortId, asOf: until, samples: [], arms: [{ experimentId: 'exp', armId: 'a', generation: 1, samples: 5, moments: addSample(emptyMoments(until), 7, 5) }] },
    records: [{ schema_version: 1, table_name: 'observations', site_id: siteId, record_id: 'sample', revision: 2,
      occurred_at: from, received_at: Date.now(), subject_key: 's', state_key: 's', cid: 'c', uid: null,
      experiment_id: 'exp', arm_id: 'a', goal_id: null, assignment_id: 'a', observation_id: 'sample', status: 'complete', value: 7,
      attributes_json: '{}', payload_json: '{}' }], next: null,
  });
  const exportData = vi.spyOn(env.ANALYTICS, 'send').mockRejectedValueOnce(new Error('temporary stream failure')).mockResolvedValue(undefined);
  await runInDurableObject(site, async (actor, state) => {
    state.storage.kv.put('learningFrom', from);
    await actor.alarm();
    expect(state.storage.kv.get('learningFrom')).toBe(from);
    expect(state.storage.kv.get('alarmFailures')).toBe(1);
  });
  expect(page).toHaveBeenCalledTimes(1);
  const before = await experiment.getPolicy();
  expect(before.arms[0]!.meanReward).toBe(7);
  await evictDurableObject(site);
  await runInDurableObject(site, async (actor, state) => {
    state.storage.kv.delete('alarmRetryAt');
    await actor.alarm();
    expect(state.storage.kv.get('learningFrom')).toBe(until);
    expect(await state.storage.getAlarm()).toBe(until + COHORT_INTERVAL_MS);
  });
  expect(page).toHaveBeenCalledTimes(1); // No second query with later-visible data.
  expect(exportData).toHaveBeenCalledTimes(2);
  expect((await experiment.getPolicy()).arms[0]!.weight).toBeCloseTo(before.arms[0]!.weight, 3);
  page.mockRestore(); exportData.mockRestore();
});

it('schedules an idle site at the next cohort boundary instead of polling every minute', async () => {
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId);
  const { settings } = await import('../../src/core/validation.js');
  await site.registerExperiment('exp', siteId, settings({ minHoldMs: 0 }));
  const boundary = Math.floor(Date.now() / COHORT_INTERVAL_MS) * COHORT_INTERVAL_MS + COHORT_INTERVAL_MS;
  await runInDurableObject(site, async (actor, state) => {
    await actor.alarm();
    expect(await state.storage.getAlarm()).toBe(boundary);
  });
});

it('reduces result partitions only for capacity failures, not transient query outages', async () => {
  const { AnalyticsCapacityError } = await import('../../src/analytics/query.js');
  const { settings } = await import('../../src/core/validation.js');
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId);
  await site.registerExperiment('exp', siteId, settings({ minHoldMs: 0 }));
  const from = Math.floor(Date.now() / COHORT_INTERVAL_MS) * COHORT_INTERVAL_MS - COHORT_INTERVAL_MS;
  const page = vi.spyOn(LearningSource.prototype, 'page')
    .mockRejectedValueOnce(new Error('temporary SQL outage'))
    .mockRejectedValueOnce(new AnalyticsCapacityError('response too large'));
  try {
    await runInDurableObject(site, async (actor, state) => {
      state.storage.kv.put('learningFrom', from);
      await actor.alarm();
      expect(state.storage.kv.get('learningLimit')).toBeUndefined();
      state.storage.kv.delete('alarmRetryAt');
      await actor.alarm();
      expect(state.storage.kv.get('learningLimit')).toBe(500);
      expect(state.storage.kv.get('learningFrom')).toBe(from);
    });
  } finally { page.mockRestore(); }
});
