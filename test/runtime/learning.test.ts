import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { EyeEvent, ExposureEvent } from '../../src/core/types.js';
import type { AnalyticsRecord } from '../../src/analytics/records.js';

it('closes durable rewards, retries delivery after eviction and applies arm moments only once without Basin', async () => {
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId);
  const config = await site.createExperiment(siteId, { experimentId: 'exp', arms: ['a', 'b'], settings: {
    minHoldMs: 0, observationWindowMs: 1000, allowedLatenessMs: 100 } });
  await site.createGoal('pay');
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
    const before = await site.getExperimentPolicy(siteId, 'exp');
    expect(before.arms[0]!.meanReward).toBeCloseTo(100 * 2 ** (-10 / config.settings.attributionHalfLifeMs));
    await evictDurableObject(site);
    await runInDurableObject(site, async (actor, state) => {
      state.storage.kv.delete('alarmRetryAt'); await actor.alarm();
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM learning_outbox').one().n).toBe(0);
    });
    expect((await site.getExperimentPolicy(siteId, 'exp')).arms[0]!.weight).toBeCloseTo(before.arms[0]!.weight, 10);
    expect(rows.filter(r => r.table_name === 'observations' && r.status === 'complete')).toHaveLength(1);
    expect(rows.filter(r => r.table_name === 'credits')).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); exportData.mockRestore(); fetchSpy.mockRestore(); }
});

it('does not poll or query an idle site just because an experiment exists', async () => {
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId);
  await site.createExperiment(siteId, { experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0 } });
  await runInDurableObject(site, async (_actor, state) => { expect(await state.storage.getAlarm()).toBeNull(); });
});

it('reclaims at most one summary expiry page when cleanup and closure share an alarm', async () => {
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId);
  const config = await site.createExperiment(siteId, { experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0, observationWindowMs: 1000, allowedLatenessMs: 0 } });
  const now = Date.now(), at = now - 2000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const send = vi.spyOn(env.ANALYTICS, 'send').mockResolvedValue(undefined);
  try {
    await runInDurableObject(site, async (actor, state) => {
      const { IncrementalLearning } = await import('../../src/runtime/incremental.js');
      const { RETENTION_MS } = await import('../../src/core/validation.js');
      const engine = new IncrementalLearning(state.storage.sql), old = now - RETENTION_MS - 3_600_000;
      state.storage.transactionSync(() => engine.summaries.configure({ goalIds: [], experimentIds: ['exp'] }, old));
      state.storage.sql.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<50000)
        INSERT INTO summary_buckets SELECT 'learning', 'exp', ?, json_array('a', n, 1000), 1, 1, 1, 0 FROM seq`, old);
      const status = JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM summary_config').one().data);
      status.rows = 50000;
      state.storage.sql.exec('UPDATE summary_config SET data=?', JSON.stringify(status));
      state.storage.transactionSync(() => engine.accept([{ kind: 'exposure', eventId: 'shown', occurredAt: at, subject: { cid: 'c' },
        assignment: { assignmentId: 'assignment', experimentId: 'exp', armId: 'a', generation: 1, policyRevision: 1, assignedAt: at, probability: 1, settings: config.settings },
        sample: { sampleId: 'sample', startAt: at }, attributionWindowMs: 1000 }], at));
      await actor.alarm();
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM summary_buckets').one().n).toBe(49001);
      expect(engine.summaries.status(now).state).toBe('collecting');
    });
  } finally { clock.mockRestore(); send.mockRestore(); }
});

it('reads each current goal once per transaction and preserves historical status and retry decisions', async () => {
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId), at = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  try {
    await runInDurableObject(site, async actor => {
      actor.createGoal('pay');
      clock.mockReturnValue(at + 10); actor.setGoalStatus('pay', 'paused');
      clock.mockReturnValue(at + 20); actor.setGoalStatus('pay', 'active');
      const current = vi.spyOn(actor, 'getGoal'), history = vi.spyOn(actor, 'goalStatusAt');
      const goal = (eventId: string, occurredAt: number): EyeEvent => ({ kind: 'goal', eventId, occurredAt, subject: { cid: 'c' }, goalId: 'pay', value: 1 });
      try {
        expect(await actor.consumeLearning(siteId, Array.from({ length: 100 }, (_, i) => goal(String(i), at + 20)))).toEqual(Array(100).fill(true));
        expect(current).toHaveBeenCalledTimes(1); expect(history).not.toHaveBeenCalled();
        expect(await actor.consumeLearning(siteId, [goal('before-create', at - 1), goal('active', at + 1), goal('paused', at + 11)])).toEqual([false, true, false]);
        expect(history).toHaveBeenCalledTimes(3);
        clock.mockReturnValue(at + 30); actor.setGoalStatus('pay', 'paused');
        expect(await actor.consumeLearning(siteId, [goal('new', at + 30), goal('0', at + 20)])).toEqual([false, true]);
      } finally { current.mockRestore(); history.mockRestore(); }
    });
  } finally { clock.mockRestore(); }
});
