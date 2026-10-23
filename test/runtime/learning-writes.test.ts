import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { parseEnvelope } from '../../src/core/events.js';
import { experimentKey, subjectKey } from '../../src/core/validation.js';
import type { EventEnvelope, ExperimentSettings, Observation } from '../../src/core/types.js';
import { observationShard, shardKey } from '../../src/runtime/shard.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(extra: Partial<ExperimentSettings> = {}) {
  const siteId = crypto.randomUUID(), subject = { cid: 'browser' }, experimentId = 'test';
  const experiment = env.EXPERIMENTS.getByName(experimentKey(siteId, experimentId));
  await experiment.create({ experimentId, arms: ['a'], settings: {
    minHoldMs: 100_000, observationWindowMs: 10_000, allowedLatenessMs: 0, ...extra,
  } });
  await env.SITES.getByName(siteId).createGoal('value');
  const user = env.SUBJECTS.getByName(subjectKey(siteId, subject));
  const decision = await user.decide(siteId, subject, experimentId);
  if (decision.status !== 'assigned') throw new Error('Missing assignment');
  const at = decision.assignment.assignedAt;
  const shard = env.OBSERVATIONS.getByName(shardKey(siteId, experimentId, observationShard(subjectKey(siteId, subject))));
  // Manual future clocks must not leave real alarms running after the clock restores.
  for (const target of [user, experiment, shard]) cleanups.push(async () => {
    await runInDurableObject(target, async (_instance, state) => { await state.storage.deleteAlarm(); });
  });
  const expose = (id: string, occurredAt = at, receivedAt = Date.now()): EventEnvelope => ({ siteId, receivedAt,
    event: { kind: 'exposure', eventId: id, occurredAt, subject, assignment: decision.assignment } });
  const goal = (id: string, value = 1, occurredAt = at, receivedAt = Date.now()): EventEnvelope => ({ siteId, receivedAt,
    event: { kind: 'goal', eventId: id, occurredAt, subject, goalId: 'value', value } });
  return { siteId, subject, experimentId, experiment, user, at, expose, goal };
}
async function rows(user: ReturnType<typeof env.SUBJECTS.getByName>) {
  return runInDurableObject(user, (_instance, state) => state.storage.sql.exec<{ data: string }>('SELECT data FROM observations ORDER BY start_at').toArray().map(r => JSON.parse(r.data) as Observation));
}

it('sends pending start once, persists local reward, then publishes final signed reward after eviction', async () => {
  const s = await setup();
  await s.user.ingest(s.expose('first')); await s.user.flush();
  const initial = (await rows(s.user))[0]!;
  const shard = env.OBSERVATIONS.getByName(shardKey(s.siteId, s.experimentId, observationShard(initial.subjectKey)));
  for (let i = 0; i < 5; i++) { await s.user.ingest(s.goal(`g${i}`, -2)); await s.user.flush(); }
  expect((await rows(s.user))[0]?.reward).toBe(-10);
  const stored = await runInDurableObject(shard, (_instance, state) => JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM observations').one().data) as Observation);
  expect(stored.revision).toBe(initial.revision); expect(stored.reward).toBe(0);
  await evictDurableObject(s.user);
  await runInDurableObject(s.user, async (instance, state) => {
    await state.storage.deleteAlarm();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(s.at + 20_000);
    try { await instance.alarm(); } finally { clock.mockRestore(); }
  });
  const policy = await runInDurableObject(s.experiment, instance => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(s.at + 20_001);
    try { return instance.getPolicy(); } finally { clock.mockRestore(); }
  });
  expect(policy.arms[0]?.meanReward).toBeCloseTo(-10);
  expect(policy.arms[0]?.weight).toBeCloseTo(1, 3);
  expect(policy.arms[0]?.pending).toBe(0);
});

it('coalesces a goal batch to one observation revision and atomically rolls back a conflicting ID', async () => {
  const s = await setup();
  await s.user.ingest(s.expose('first')); await s.user.flush();
  const before = (await rows(s.user))[0]!;
  const goals = Array.from({ length: 100 }, (_, i) => s.goal(`g${i}`, i % 2 ? -1 : 2));
  const site = env.SITES.getByName(s.siteId);
  let queries = 0;
  await runInDurableObject(site, instance => {
    const prototype = Object.getPrototypeOf(instance) as typeof instance;
    const original = prototype.goalStatusAt;
    vi.spyOn(prototype, 'goalStatusAt').mockImplementation(function (this: typeof instance, ...args) {
      queries++;
      return original.apply(this, args);
    });
  });
  try { await s.user.ingestGoals(goals); expect(queries).toBe(1); }
  finally {
    await runInDurableObject(site, instance => { vi.mocked((Object.getPrototypeOf(instance) as typeof instance).goalStatusAt).mockRestore(); });
  }
  const after = (await rows(s.user))[0]!;
  expect(after.reward).toBe(50); expect(after.revision).toBe(before.revision + 1);
  expect((await s.user.ingestGoals(goals)).every(r => r.status === 'duplicate')).toBe(true);
  expect(await rows(s.user)).toEqual([after]);
  await runInDurableObject(s.user, async (instance, state) => {
    await expect(instance.ingestGoals([s.goal('valid-before-conflict', 20), s.goal('g0', 99)])).rejects.toThrow('reused');
    expect(state.storage.sql.exec<{ n: number }>("SELECT count(*) n FROM events WHERE id = 'valid-before-conflict'").one().n).toBe(0);
  });
  expect(await rows(s.user)).toEqual([after]);
  await s.user.ingest(s.goal('after-rollback', 3));
  expect((await rows(s.user))[0]?.reward).toBe(53);
});

it('stores an exposure once, deduplicates across legacy tables, and still exports raw events', async () => {
  const s = await setup(), exposure = s.expose('only');
  await s.user.ingest(exposure);
  expect((await s.user.ingest(exposure)).status).toBe('duplicate');
  await runInDurableObject(s.user, async (instance, state) => {
    expect(state.storage.sql.exec<{ n: number }>('SELECT count(*) n FROM events').one().n).toBe(0);
    expect(state.storage.sql.exec<{ n: number }>('SELECT count(*) n FROM exposures').one().n).toBe(1);
    const exports = state.storage.sql.exec<{ data: string }>("SELECT data FROM outbox WHERE kind = 'export'").toArray().map(r => JSON.parse(r.data).record);
    expect(exports.some(r => r.table_name === 'events' && r.record_id === 'only')).toBe(true);
    state.storage.sql.exec('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)', 'legacy', 'exposure', s.at, s.at, 'accepted', JSON.stringify(parseEnvelope({ ...exposure, event: { ...exposure.event, eventId: 'legacy' } }, Date.now()).event));
    expect((await instance.ingest({ ...exposure, event: { ...exposure.event, eventId: 'legacy' } })).status).toBe('duplicate');
    await expect(instance.ingest(s.goal('only'))).rejects.toThrow('reused');
  });
});

it('freezes learned reward at the correction deadline but retains late raw goals and analytic credit', async () => {
  const s = await setup({ correctionWindowMs: 1000 });
  await s.user.ingest(s.expose('first'));
  await runInDurableObject(s.user, async (instance, state) => {
    await state.storage.deleteAlarm();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(s.at + 11_000);
    try {
      await instance.ingest(s.goal('at-deadline', 7, s.at, s.at + 11_000));
      await instance.alarm();
    } finally { clock.mockRestore(); }
  });
  const before = (await rows(s.user))[0]!;
  expect(before.status).toBe('complete'); expect(before.reward).toBe(7);
  await evictDurableObject(s.user);
  await runInDurableObject(s.user, async (instance, state) => {
    await state.storage.deleteAlarm();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(s.at + 11_001);
    try {
      await instance.ingest(s.goal('too-late', 50, s.at, s.at + 11_001));
      const credit = JSON.parse(state.storage.sql.exec<{ data: string }>("SELECT data FROM credits WHERE goal_id = 'too-late'").one().data);
      expect(credit.learningClosed).toBe(true); expect(credit.value).toBe(50);
      expect(state.storage.sql.exec<{ n: number }>("SELECT count(*) n FROM events WHERE id = 'too-late'").one().n).toBe(1);
    } finally { clock.mockRestore(); }
  });
  expect(await rows(s.user)).toEqual([before]);
});

it('does not shift a frozen window when an earlier exposure arrives and does not create a late learned zero', async () => {
  const s = await setup({ correctionWindowMs: 1000 });
  await runInDurableObject(s.user, async (instance, state) => {
    await state.storage.deleteAlarm();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(s.at + 100);
    try { await instance.ingest(s.expose('later', s.at + 100, s.at + 100)); } finally { clock.mockRestore(); }
  });
  await runInDurableObject(s.user, async (instance, state) => {
    await state.storage.deleteAlarm();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(s.at + 12_000);
    try {
      await instance.alarm();
      await instance.ingest(s.expose('earlier', s.at, s.at + 12_000));
    } finally { clock.mockRestore(); }
  });
  const observations = await rows(s.user);
  expect(observations).toHaveLength(1); expect(observations[0]?.startAt).toBe(s.at + 100);
  expect(observations[0]?.status).toBe('complete');
  const t = await setup({ correctionWindowMs: 1000 });
  await runInDurableObject(t.user, async (instance, state) => {
    await state.storage.deleteAlarm();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t.at + 12_000);
    try { await instance.ingest(t.expose('first-but-expired', t.at, t.at + 12_000)); } finally { clock.mockRestore(); }
  });
  expect((await rows(t.user))[0]?.status).toBe('interrupted');
  expect((await rows(t.user))[0]?.interruptReason).toBe('correction_expired');
});

it('counts a delayed zero completion even if the alarm runs beyond the correction deadline', async () => {
  const s = await setup({ correctionWindowMs: 0 });
  await s.user.ingest(s.expose('zero'));
  await runInDurableObject(s.user, async (instance, state) => {
    await state.storage.deleteAlarm();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(s.at + 20_000);
    try { await instance.alarm(); } finally { clock.mockRestore(); }
  });
  const observation = (await rows(s.user))[0]!;
  expect(observation.status).toBe('complete'); expect(observation.reward).toBe(0);
  await runInDurableObject(s.experiment, instance => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(s.at + 20_001);
    try { expect(instance.getPolicy().arms[0]?.weight).toBeCloseTo(1, 3); } finally { clock.mockRestore(); }
  });
});

async function measureWrites(s: Awaited<ReturnType<typeof setup>>, work: () => Promise<void>) {
  const observation = (await rows(s.user))[0]!;
  const shard = env.OBSERVATIONS.getByName(shardKey(s.siteId, s.experimentId, observationShard(observation.subjectKey)));
  const counts = { subjectSql: 0, subjectKv: 0, shardSql: 0, shardKv: 0 };
  // Real SQL and KV calls, including delivery and outbox deletion.
  for (const [target, sqlKey, kvKey] of [[s.user, 'subjectSql', 'subjectKv'], [shard, 'shardSql', 'shardKv']] as const) {
    await runInDurableObject(target, (_instance, state) => {
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      vi.spyOn(state.storage.sql, 'exec').mockImplementation((...args: Parameters<SqlStorage['exec']>) => {
        const cursor = exec(...args); counts[sqlKey] += cursor.rowsWritten; return cursor;
      });
      const put = state.storage.kv.put.bind(state.storage.kv);
      vi.spyOn(state.storage.kv, 'put').mockImplementation((key, value) => { if (key !== 'alarmAt') counts[kvKey]++; put(key, value); });
      const del = state.storage.kv.delete.bind(state.storage.kv);
      vi.spyOn(state.storage.kv, 'delete').mockImplementation(key => { if (key !== 'alarmAt') counts[kvKey]++; return del(key); });
    });
  }
  try {
    await work();
    // flush() intentionally caps exports at 100. Include every remaining delete.
    for (let i = 0; ; i++) {
      const pending = await runInDurableObject(s.user, (_instance, state) => state.storage.sql.exec<{ n: number }>('SELECT count(*) n FROM outbox').one().n);
      if (pending === 0) break;
      expect(i).toBeLessThan(10);
      await s.user.flush();
    }
    return counts;
  }
  finally {
    await runInDurableObject(s.user, () => vi.restoreAllMocks());
    await runInDurableObject(shard, () => vi.restoreAllMocks());
  }
}

it.each([false, true])('measures pending goal writes with coalescing=%s', async batch => {
  const s = await setup();
  await s.user.ingest(s.expose('first')); await s.user.flush();
  const counts = await measureWrites(s, async () => {
    if (batch) {
      await s.user.ingestGoals(Array.from({ length: 100 }, (_, i) => s.goal(`p${i}`)));
      await s.user.flush();
    } else {
      for (let i = 0; i < 100; i++) { await s.user.ingest(s.goal(`p${i}`)); await s.user.flush(); }
    }
  });
  expect((await rows(s.user))[0]?.reward).toBe(100);
  expect(counts).toEqual(batch
    ? { subjectSql: 1506, subjectKv: 201, shardSql: 0, shardKv: 0 }
    : { subjectSql: 2100, subjectKv: 300, shardSql: 0, shardKv: 0 });
});

it('does not let a frozen superseded window swallow the following active window on replay', async () => {
  const s = await setup({ correctionWindowMs: 1000 });
  await runInDurableObject(s.user, async (instance, state) => {
    await state.storage.deleteAlarm();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(s.at + 100);
    try {
      await instance.ingest(s.expose('initial-later', s.at + 100, s.at + 100));
      await instance.ingest(s.expose('earlier', s.at, s.at + 100));
      clock.mockReturnValue(s.at + 10_020);
      await instance.ingest(s.expose('next', s.at + 10_020, s.at + 10_020));
      clock.mockReturnValue(s.at + 11_200);
      await instance.alarm();
      await instance.ingest(s.expose('late-within-first', s.at + 50, s.at + 11_200));
    } finally { clock.mockRestore(); }
  });
  const observations = await rows(s.user);
  expect(observations.find(o => o.startAt === s.at + 10_020)?.status).toBe('pending');
  expect(observations.find(o => o.startAt === s.at)?.status).toBe('complete');
  expect(observations.find(o => o.startAt === s.at + 100)?.status).toBe('interrupted');
});


it('stops the last-touch cursor after the first matching exposure instead of reading retained history', async () => {
  const s = await setup();
  await s.user.ingest(s.expose('first'));
  await runInDurableObject(s.user, async (instance, state) => {
    await state.storage.deleteAlarm();
    const row = state.storage.sql.exec<{ experiment_id: string; assignment_id: string; occurred_at: number; observation_id: string; data: string }>('SELECT * FROM exposures').one();
    state.storage.transactionSync(() => {
      for (let i = 0; i < 5000; i++) {
        const event = { ...JSON.parse(row.data), eventId: `history-${i}` };
        state.storage.sql.exec('INSERT INTO exposures VALUES (?, ?, ?, ?, ?, ?)', event.eventId, row.experiment_id, row.assignment_id, row.occurred_at, row.observation_id, JSON.stringify(event));
      }
    });
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    let lookup: { readonly rowsRead: number } | undefined;
    const spy = vi.spyOn(state.storage.sql, 'exec').mockImplementation((...args: Parameters<SqlStorage['exec']>) => {
      const cursor = exec(...args);
      if (args[0].startsWith('SELECT data, observation_id, assignment_id FROM exposures')) lookup = cursor;
      return cursor;
    });
    try {
      await instance.ingest(s.goal('efficient-last-touch', 7));
      expect(lookup).toBeDefined();
      expect(lookup!.rowsRead).toBeLessThan(20);
      expect(JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM observations').one().data).reward).toBe(7);
    } finally { spy.mockRestore(); }
  });
});
