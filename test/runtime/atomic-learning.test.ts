import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { addSample, emptyMoments } from '../../src/core/moments.js';
import { experimentKey } from '../../src/core/validation.js';
import { IncrementalLearning } from '../../src/runtime/incremental.js';
import type { EyeEvent, ExposureEvent, Experiment } from '../../src/core/types.js';
import type { AnalyticsRecord } from '../../src/analytics/records.js';

it('commits closure/moments/export together, rolls all back on SQL failure, and makes no experiment RPC for a new site', async () => {
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId), at = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at), legacy = vi.spyOn(env.EXPERIMENTS, 'getByName');
  const send = vi.spyOn(env.ANALYTICS, 'send').mockResolvedValue(undefined);
  try {
    const config = await exports.default.createExperiment(siteId, { experimentId: 'exp', arms: ['a'], settings: {
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
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='applied_cohorts'").toArray()).toEqual([]);
    });
    const policy = await exports.default.getPolicy(siteId, 'exp');
    expect(policy.arms[0]!.meanReward).toBeCloseTo(100 * 2 ** (-10 / config.settings.attributionHalfLifeMs));
    expect(legacy).not.toHaveBeenCalled();
    await evictDurableObject(site);
    await runInDurableObject(site, async actor => { await actor.alarm(); });
    expect((await exports.default.getPolicy(siteId, 'exp')).arms[0]!.weight).toBeCloseTo(policy.arms[0]!.weight, 10);
  } finally { clock.mockRestore(); send.mockRestore(); legacy.mockRestore(); }
});

it('imports existing moments and publication sequence, skips already-applied old outboxes, and applies unapplied ones once', async () => {
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId), at = Date.now();
  const legacy = env.EXPERIMENTS.getByName(experimentKey(siteId, 'exp'));
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at), rows: AnalyticsRecord[] = [];
  const send = vi.spyOn(env.ANALYTICS, 'send').mockImplementation(async data => { rows.push(...data as AnalyticsRecord[]); });
  try {
    const config = await legacy.create({ experimentId: 'exp', arms: ['a', 'b'], settings: { minHoldMs: 0 } });
    const cohort = (cohortId: string, reward: number) => ({ cohortId, asOf: at,
      arms: [{ experimentId: 'exp', armId: 'a', generation: 1, samples: 1, moments: addSample(emptyMoments(at), reward) }] });
    await legacy.applyCohort(cohort('already', 10));
    const publication = await legacy.publishedPolicy(siteId);
    await runInDurableObject(site, (_actor, state) => {
      state.storage.kv.put('siteId', siteId); state.storage.kv.delete('legacyExperimentLayout');
      state.storage.sql.exec('INSERT INTO experiments VALUES (?,?)', 'exp', at);
      for (const output of [cohort('already', 10), cohort('unapplied', 30)])
        state.storage.sql.exec('INSERT INTO learning_outbox(data) VALUES (?)', JSON.stringify({ cohort: output, records: [] }));
    });
    await evictDurableObject(site);
    const imported = await exports.default.getPolicy(siteId, 'exp');
    expect(imported.arms[0]!.meanReward).toBe(10);
    await runInDurableObject(site, async actor => { await actor.alarm(); });
    const learned = await exports.default.getPolicy(siteId, 'exp');
    expect(learned.arms[0]!.weight).toBe(2); expect(learned.arms[0]!.meanReward).toBeCloseTo(20, 12);
    const next = await exports.default.getPublishedPolicy(siteId, 'exp');
    expect(next.sequence).toBe(publication.sequence + 1);
    await evictDurableObject(site);
    await runInDurableObject(site, async actor => { await actor.alarm(); });
    expect((await exports.default.getPolicy(siteId, 'exp')).arms[0]!.weight).toBe(2);
    await runInDurableObject(legacy, actor => { expect(() => actor.applyCohort(cohort('late-legacy', 100))).toThrow('migrated'); });
    // Retired object's pending policy outbox remains deliverable after sealing.
    await runInDurableObject(legacy, async actor => { await actor.alarm(); });
    expect(rows.filter(row => row.table_name === 'policies').some(row => JSON.parse(row.payload_json).sequence === publication.sequence)).toBe(true);
    expect((await exports.default.getExperiment(siteId, 'exp')).settings).toEqual(config.settings);
  } finally { clock.mockRestore(); send.mockRestore(); }
});

it('matches the previous separate-object learner over normal multi-experiment cycles', async () => {
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId), baseline = env.SITES.getByName(crypto.randomUUID());
  let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const send = vi.spyOn(env.ANALYTICS, 'send').mockResolvedValue(undefined);
  const ids = ['one', 'two', 'three', 'four'];
  const references = ids.map(id => env.EXPERIMENTS.getByName(experimentKey(`reference-${siteId}`, id)));
  try {
    await site.createGoal('pay');
    const configs: Experiment[] = [];
    for (const [i, experimentId] of ids.entries()) {
      const input = { experimentId, arms: ['a', 'b'], settings: { minHoldMs: 0, observationWindowMs: 1000, allowedLatenessMs: 0 } };
      configs.push(await exports.default.createExperiment(siteId, input)); await references[i]!.create(input);
    }
    let previousRPCs = 0;
    const rpc = vi.spyOn(env.EXPERIMENTS, 'getByName');
    try {
      for (let cycle = 0; cycle < 5; cycle++) {
        if (cycle === 2) {
          configs[0] = await exports.default.updateExperiment(siteId, ids[0]!, { learningHalfLifeMs: 300_000 });
          await references[0]!.updateSettings({ learningHalfLifeMs: 300_000 });
          await exports.default.setArmStatus(siteId, ids[1]!, 'b', 'paused'); await references[1]!.setArmStatus('b', 'paused');
        }
        if (cycle === 3) {
          await exports.default.setArmStatus(siteId, ids[1]!, 'b', 'active'); await references[1]!.setArmStatus('b', 'active');
          await exports.default.addArm(siteId, ids[2]!, 'c'); await references[2]!.addArm('c');
        }
        const events: EyeEvent[] = [];
        for (let user = 0; user < 10; user++) {
          const prefix = `${cycle}-${user}`, subject = { cid: prefix };
          for (const [i, experimentId] of ids.entries()) events.push({ kind: 'exposure', eventId: `${prefix}-${i}`, subject, occurredAt: now,
            assignment: { assignmentId: `${prefix}-${i}`, experimentId, armId: user % 2 ? 'a' : 'b', generation: configs[i]!.generation,
              assignedAt: now, policyRevision: 1, probability: .5, settings: configs[i]!.settings },
            sample: { sampleId: `${prefix}-${i}`, startAt: now }, attributionWindowMs: 1000 });
          if (user % 3) events.push({ kind: 'goal', eventId: `${prefix}-goal`, subject, occurredAt: now + 10, goalId: 'pay', value: user % 2 ? 100 : -30 });
        }
        now += 10; await site.consumeLearning(siteId, events);
        await runInDurableObject(baseline, (_actor, state) => state.storage.transactionSync(() => new IncrementalLearning(state.storage.sql).accept(events, now)));
        now += 2000;
        const outputs = await runInDurableObject(baseline, (_actor, state) => {
          const engine = new IncrementalLearning(state.storage.sql);
          state.storage.transactionSync(() => engine.close(siteId, now)); return engine.outputs();
        });
        for (const { output } of outputs) for (const [i, experimentId] of ids.entries()) {
          await references[i]!.applyCohort({ ...output.cohort, arms: output.cohort.arms.filter(arm => arm.experimentId === experimentId) }); previousRPCs++;
        }
        await runInDurableObject(baseline, (_actor, state) => new IncrementalLearning(state.storage.sql).acknowledge(outputs.map(output => output.id)));
        await runInDurableObject(site, async actor => { await actor.alarm(); });
        for (const [i, experimentId] of ids.entries()) {
          expect(await exports.default.getPolicy(siteId, experimentId)).toEqual(await references[i]!.getPolicy());
          expect(await exports.default.getPublishedPolicy(siteId, experimentId)).toEqual(await references[i]!.publishedPolicy());
        }
        now += 60_000;
      }
      expect(previousRPCs).toBe(20); expect(rpc).not.toHaveBeenCalled();
    } finally { rpc.mockRestore(); }
  } finally { clock.mockRestore(); send.mockRestore(); }
});

it('resumes paged import after failure and eviction without exposing or overwriting partial moments', async () => {
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId), key = experimentKey(siteId, 'exp');
  const legacy = env.EXPERIMENTS.getByName(key), at = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  try {
    const armIds = Array.from({ length: 125 }, (_, i) => `a${String(i).padStart(3, '0')}`);
    await legacy.create({ experimentId: 'exp', arms: armIds, settings: { minHoldMs: 0 } });
    const apply = async (generation: number) => legacy.applyCohort({ cohortId: `g-${generation}`, asOf: at,
      arms: armIds.map(armId => ({ experimentId: 'exp', armId, generation, samples: 1, moments: addSample(emptyMoments(at), generation) })) });
    await apply(1);
    for (let i = 2; i <= 105; i++) await legacy.updateSettings({ rewardScale: i });
    await apply(105);
    const expected = await legacy.getPolicy();
    await runInDurableObject(site, (_actor, state) => {
      state.storage.kv.put('siteId', siteId); state.storage.kv.delete('legacyExperimentLayout');
      state.storage.sql.exec('INSERT INTO experiments VALUES (?,?)', 'exp', at);
    });
    await evictDurableObject(site);
    await runInDurableObject(site, async (actor, state) => {
      // RPC stubs must be created in the DO context that uses them.
      const local = env.EXPERIMENTS.getByName(key), original = env.EXPERIMENTS.getByName.bind(env.EXPERIMENTS);
      const broken = new Proxy(local, { get(target, name) {
        if (name === 'migrationMoments') return (site: string, after: { generation: number; armId: string } | null) => {
          if (after) throw new Error('injected import failure');
          return target.migrationMoments(site, after);
        };
        return Reflect.get(target, name);
      } });
      const lookup = vi.spyOn(env.EXPERIMENTS, 'getByName').mockImplementation(name => name === key ? broken : original(name));
      try {
        await expect(actor.getExperiment(siteId, 'exp')).rejects.toThrow('injected import failure');
        expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) n FROM local_arm_moments').one().n).toBe(100);
      } finally { lookup.mockRestore(); }
    });
    await evictDurableObject(site);
    expect((await exports.default.getExperiment(siteId, 'exp')).generation).toBe(105);
    expect(await exports.default.getPolicy(siteId, 'exp')).toEqual(expected);
    await runInDurableObject(site, (_actor, state) => {
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) n FROM local_arm_moments').one().n).toBe(250);
      expect(state.storage.kv.get<{ rewardScale: number }>(JSON.stringify(['experiment', 'exp', 'generation:50']))?.rewardScale).toBe(50);
    });
  } finally { clock.mockRestore(); }
});

it('handles concurrent normal collection and a full close batch without losing zero samples', async () => {
  const siteId = crypto.randomUUID(), site = env.SITES.getByName(siteId), at = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at), records: AnalyticsRecord[] = [];
  const send = vi.spyOn(env.ANALYTICS, 'send').mockImplementation(async rows => { records.push(...rows as AnalyticsRecord[]); });
  try {
    const config = await exports.default.createExperiment(siteId, { experimentId: 'exp', arms: ['a'], settings: {
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
    const policy = await exports.default.getPolicy(siteId, 'exp');
    expect(policy.arms[0]!.meanReward).toBe(0);
    expect(policy.arms[0]!.weight).toBeCloseTo(500 * 2 ** (-1000 / config.settings.learningHalfLifeMs), 8);
    expect(records.filter(row => row.table_name === 'observations')).toHaveLength(500);
  } finally { clock.mockRestore(); send.mockRestore(); }
});
