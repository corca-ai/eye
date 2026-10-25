import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { experimentKey } from '../../src/core/validation.js';
import type { EyeEvent, ExposureEvent } from '../../src/core/types.js';
import type { AnalyticsRecord } from '../../src/analytics/records.js';

it('closes durable rewards, retries delivery after eviction and applies arm moments only once without Basin', async () => {
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId);
  const experiment = env.EXPERIMENTS.getByName(experimentKey(siteId, 'exp'));
  const config = await experiment.create({ experimentId: 'exp', arms: ['a', 'b'], settings: {
    minHoldMs: 0, observationWindowMs: 1000, allowedLatenessMs: 100 } });
  await site.createGoal('pay'); await site.registerExperiment('exp', siteId, config.settings);
  const at = Date.now();
  const exposure: ExposureEvent = { kind: 'exposure', eventId: 'a-exposure', occurredAt: at,
    subject: { cid: 'c' }, assignment: { assignmentId: 'assignment', experimentId: 'exp', armId: 'a',
      generation: 1, assignedAt: at, policyRevision: 1, probability: .5, settings: config.settings },
    sample: { sampleId: 'sample', startAt: at }, attributionWindowMs: 1000 };
  // Goal creation precedes its event time; Date.now in user code is advanced only.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at + 10);
  const rows: AnalyticsRecord[] = [];
  const exportData = vi.spyOn(env.ANALYTICS, 'send').mockImplementation(async data => { rows.push(...data as AnalyticsRecord[]); });
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('learning must not query Basin'));
  try {
    const events: EyeEvent[] = [{ kind: 'goal', eventId: 'z-goal', occurredAt: at + 10,
      subject: { cid: 'c' }, goalId: 'pay', value: 100 }, exposure];
    expect(await site.consumeLearning(siteId, events)).toEqual([true, true]);
    expect(await site.consumeLearning(siteId, events)).toEqual([true, true]);
    clock.mockReturnValue(at + 1200);
    exportData.mockRejectedValueOnce(new Error('temporary stream failure'));
    await runInDurableObject(site, async (actor, state) => {
      await actor.alarm();
      expect(state.storage.kv.get('alarmFailures')).toBe(1);
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM learning_outbox').one().n).toBeGreaterThan(0);
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM learning_samples').one().n).toBe(0);
    });
    const before = await experiment.getPolicy();
    expect(before.arms[0]!.meanReward).toBeCloseTo(100 * 2 ** (-10 / config.settings.attributionHalfLifeMs));
    await evictDurableObject(site);
    await runInDurableObject(site, async (actor, state) => {
      state.storage.kv.delete('alarmRetryAt'); await actor.alarm();
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM learning_outbox').one().n).toBe(0);
    });
    expect((await experiment.getPolicy()).arms[0]!.weight).toBeCloseTo(before.arms[0]!.weight, 10);
    expect(rows.filter(r => r.table_name === 'observations' && r.status === 'complete')).toHaveLength(1);
    expect(rows.filter(r => r.table_name === 'credits')).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); exportData.mockRestore(); fetchSpy.mockRestore(); }
});

it('does not poll or query an idle site just because an experiment exists', async () => {
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId);
  const { settings } = await import('../../src/core/validation.js');
  await site.registerExperiment('exp', siteId, settings({ minHoldMs: 0 }));
  await runInDurableObject(site, async (_actor, state) => { expect(await state.storage.getAlarm()).toBeNull(); });
});

it('does not let a cohort older than dedup retention block the site forever', async () => {
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId);
  const { settings, RETENTION_MS } = await import('../../src/core/validation.js');
  await site.registerExperiment('exp', siteId, settings({ minHoldMs: 0 }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await runInDurableObject(site, async (actor, state) => {
      state.storage.sql.exec('INSERT INTO learning_outbox(data) VALUES (?)', JSON.stringify({
        cohort: { cohortId: 'expired', asOf: Date.now() - RETENTION_MS - 1, arms: [] }, records: [],
      }));
      await actor.alarm();
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM learning_outbox').one().n).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('learning_retention_gap'));
  } finally { warn.mockRestore(); }
});
