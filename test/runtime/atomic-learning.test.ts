import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { EyeEvent, Experiment, ExposureEvent } from '../../src/core/types.js';
import type { AnalyticsRecord } from '../../src/analytics/records.js';

it('commits closure/moments/export together, rolls all back on SQL failure, across restart', async () => {
  const siteId = env.EYE_INSTALLATION_ID, site = env.SITES.getByName(siteId), at = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  const send = vi.spyOn(env.ANALYTICS, 'send').mockResolvedValue(undefined);
  try {
    const config = await exports.default.createExperiment({ experimentId: 'exp', arms: ['a'], settings: {
      minHoldMs: 0, observationWindowMs: 1000, allowedLatenessMs: 0 } });
    await site.createGoal('pay');
    const exposure: ExposureEvent = { kind: 'exposure', eventId: 'shown', subject: { cid: 'c' }, occurredAt: at,
      assignment: { assignmentId: 'assignment', experimentId: 'exp', armId: 'a', generation: 1, assignedAt: at,
        policyRevision: 1, probability: 1, settings: config.settings }, sample: { sampleId: 'sample', startAt: at }, attributionWindowMs: 1000 };
    clock.mockReturnValue(at + 10);
    await site.consumeLearning(siteId, [exposure, { kind: 'goal', eventId: 'paid', subject: { cid: 'c' }, occurredAt: at + 10, goalId: 'pay', value: 100 }]);
    clock.mockReturnValue(at + 2000);
    await runInDurableObject(site, async (actor, state) => {
      state.storage.sql.exec("CREATE TRIGGER fail_moments BEFORE INSERT ON local_arm_moments BEGIN SELECT RAISE(ABORT,'moment failure'); END");
      await actor.alarm();
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) n FROM learning_samples').one().n).toBe(1);
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) n FROM learning_outbox').one().n).toBe(0);
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) n FROM local_arm_moments').one().n).toBe(0);
      state.storage.sql.exec('DROP TRIGGER fail_moments'); state.storage.kv.delete('alarmRetryAt');
      await actor.alarm();
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) n FROM learning_samples').one().n).toBe(0);
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) n FROM local_arm_moments').one().n).toBe(1);
    });
    const policy = await exports.default.getPolicy('exp');
    expect(policy.arms[0]!.meanReward).toBeCloseTo(100 * 2 ** (-10 / config.settings.attributionHalfLifeMs));
    await evictDurableObject(site);
    await runInDurableObject(site, async actor => { await actor.alarm(); });
    expect((await exports.default.getPolicy('exp')).arms[0]!.weight).toBeCloseTo(policy.arms[0]!.weight, 10);
  } finally { clock.mockRestore(); send.mockRestore(); }
});

it('handles concurrent normal collection and a full close batch without losing zero samples', async () => {
  const siteId = env.EYE_INSTALLATION_ID, site = env.SITES.getByName(siteId), at = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at), records: AnalyticsRecord[] = [];
  const send = vi.spyOn(env.ANALYTICS, 'send').mockImplementation(async rows => { records.push(...rows as AnalyticsRecord[]); });
  try {
    const config = await exports.default.createExperiment({ experimentId: 'exp', arms: ['a'], settings: {
      minHoldMs: 0, observationWindowMs: 1000, allowedLatenessMs: 0 } });
    const batches = Array.from({ length: 20 }, (_, batch) => Array.from({ length: 25 }, (_, index): ExposureEvent => {
      const key = `${batch}-${index}`; return { kind: 'exposure', eventId: key, subject: { cid: key }, occurredAt: at,
        assignment: { assignmentId: key, experimentId: 'exp', armId: 'a', generation: 1, assignedAt: at,
          policyRevision: 1, probability: 1, settings: config.settings }, sample: { sampleId: key, startAt: at }, attributionWindowMs: 1000 };
    }));
    expect((await Promise.all(batches.map(batch => site.consumeLearning(siteId, batch)))).flat().every(Boolean)).toBe(true);
    clock.mockReturnValue(at + 2000);
    await runInDurableObject(site, async (actor, state) => {
      for (let i = 0; i < 5 && state.storage.sql.exec('SELECT sample_id FROM learning_samples LIMIT 1').toArray().length; i++) await actor.alarm();
      expect(state.storage.sql.exec('SELECT sample_id FROM learning_samples LIMIT 1').toArray()).toEqual([]);
    });
    const policy = await exports.default.getPolicy('exp');
    expect(policy.arms[0]!.meanReward).toBe(0);
    expect(policy.arms[0]!.weight).toBeCloseTo(500 * 2 ** (-1000 / config.settings.learningHalfLifeMs), 8);
    expect(records.filter(row => row.table_name === 'observations')).toHaveLength(500);
  } finally { clock.mockRestore(); send.mockRestore(); }
});

it('keeps experiment and generation evidence separate through settings and arm changes', async () => {
  const siteId = env.EYE_INSTALLATION_ID, site = env.SITES.getByName(siteId), at = Date.now();
  let now = at;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const send = vi.spyOn(env.ANALYTICS, 'send').mockResolvedValue(undefined);
  try {
    const ids = ['one', 'two', 'three', 'four'], configs: Experiment[] = [];
    await site.createGoal('pay');
    for (const experimentId of ids) configs.push(await exports.default.createExperiment({
      experimentId, arms: ['a', 'b'], settings: { minHoldMs: 0, observationWindowMs: 1000, allowedLatenessMs: 0 },
    }));
    const collect = async (cycle: number) => {
      const events: EyeEvent[] = [];
      for (let user = 0; user < 10; user++) {
        const key = `${cycle}-${user}`, subject = { cid: key };
        for (const [i, experimentId] of ids.entries()) {
          const config = configs[i]!;
          events.push({ kind: 'exposure', eventId: `${key}-${i}`, subject, occurredAt: now,
            assignment: { assignmentId: `${key}-${i}`, experimentId, armId: user % 2 ? 'a' : 'b',
              generation: config.generation, assignedAt: now, policyRevision: config.revision, probability: .5, settings: config.settings },
            sample: { sampleId: `${key}-${i}`, startAt: now }, attributionWindowMs: 1000 });
        }
        events.push({ kind: 'goal', eventId: `${key}-goal`, subject, occurredAt: now + 10, goalId: 'pay', value: user % 2 ? 100 : -30 });
      }
      now += 10; expect((await site.consumeLearning(siteId, events)).every(Boolean)).toBe(true);
      now += 1990; await runInDurableObject(site, async actor => { await actor.alarm(); });
    };
    await collect(0);
    const factor = 2 ** (-10 / configs[0]!.settings.attributionHalfLifeMs);
    for (const id of ids) {
      const policy = await exports.default.getPolicy(id);
      expect(policy.arms.find(arm => arm.armId === 'a')!.meanReward).toBeCloseTo(25 * factor, 10);
      expect(policy.arms.find(arm => arm.armId === 'b')!.meanReward).toBeCloseTo(-7.5 * factor, 10);
    }
    configs[0] = await exports.default.updateExperiment('one', { learningHalfLifeMs: 300_000 });
    expect((await exports.default.getPolicy('one')).arms.every(arm => arm.weight === 0)).toBe(true);
    await exports.default.setArmStatus('two', 'b', 'paused');
    await exports.default.addArm('three', 'c');
    now = at + 60_000; await collect(1);
    const policy = await exports.default.getPolicy('one');
    expect(policy.generation).toBe(2);
    expect(policy.arms.find(arm => arm.armId === 'a')!.weight).toBeCloseTo(5 * 2 ** (-1000 / 300_000), 10);
    expect((await exports.default.getPolicy('two')).arms.map(arm => arm.armId)).toEqual(['a']);
    await exports.default.setArmStatus('two', 'b', 'active');
    const halfLife = configs[1]!.settings.learningHalfLifeMs;
    expect((await exports.default.getPolicy('two')).arms.find(arm => arm.armId === 'b')!.weight)
      .toBeCloseTo(5 * (2 ** (-61_000 / halfLife) + 2 ** (-1000 / halfLife)), 10);
    expect((await exports.default.getPolicy('three')).arms.find(arm => arm.armId === 'c')!.weight).toBe(0);
    await evictDurableObject(site);
    expect(await exports.default.getPolicy('one')).toEqual(policy);
  } finally { clock.mockRestore(); send.mockRestore(); }
});

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
