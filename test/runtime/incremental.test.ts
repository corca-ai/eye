import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { IncrementalLearning } from '../../src/runtime/incremental.js';
import { reduceClosedCohort } from '../../src/core/closed-cohort.js';
import { compareEvents } from '../../src/core/attribution.js';
import { meanOf, stddevOf } from '../../src/core/moments.js';
import { settings, RETENTION_MS } from '../../src/core/validation.js';
import type { EyeEvent, ExposureEvent, GoalEvent, IdentityEvent, Subject } from '../../src/core/types.js';

const config = settings({ minHoldMs: 0, observationWindowMs: 1000, allowedLatenessMs: 10,
  attributionHalfLifeMs: 100, learningHalfLifeMs: 10000 });
const anon: Subject = { cid: 'browser' };
function exposure(id: string, at: number, experimentId = 'e', subject = anon, extra: Partial<ExposureEvent> = {}): ExposureEvent {
  return { kind: 'exposure', eventId: id, occurredAt: at, subject,
    assignment: { assignmentId: id, experimentId, armId: 'a', assignedAt: 0, generation: 1, policyRevision: 1, probability: .5, settings: config },
    sample: { sampleId: id, startAt: at }, attributionWindowMs: 100, ...extra };
}
function goal(id: string, at: number, value: number, subject = anon): GoalEvent {
  return { kind: 'goal', eventId: id, occurredAt: at, subject, goalId: 'pay', value };
}

it('matches batch rewards and moments for login boundaries, concurrent experiments, signed goals, repeats and zero outcomes', async () => {
  const a = { cid: 'browser', uid: 'a' }, b = { cid: 'browser', uid: 'b' };
  const first = exposure('first', 10);
  const events: EyeEvent[] = [
    first, exposure('repeat', 20, 'e', anon, { assignment: first.assignment, sample: first.sample! }),
    exposure('other', 15, 'f'), goal('anonymous', 25, 100),
    { kind: 'identify', eventId: 'login-a', occurredAt: 30, subject: a },
    goal('another-device', 40, -20, { cid: 'other-device', uid: 'a' }),
    { kind: 'logout', eventId: 'logout', occurredAt: 50, subject: anon },
    exposure('fresh', 60), { kind: 'identify', eventId: 'login-b', occurredAt: 70, subject: b },
    goal('b-goal', 80, 10, b), { kind: 'identify', eventId: 'switch', occurredAt: 90, subject: a },
    goal('a-goal', 100, 40, a), exposure('zero', 200, 'zero', { cid: 'zero' }),
  ];
  const reference = reduceClosedCohort({ cohortId: 'reference', from: 0, until: 2000, asOf: 2000,
    exposures: events.filter(e => e.kind === 'exposure').map(event => ({ event, sampleId: event.sample!.sampleId,
      startAt: event.sample!.startAt, attributionWindowMs: event.attributionWindowMs! })),
    goals: events.filter(e => e.kind === 'goal'), identities: events.filter((e): e is IdentityEvent => e.kind === 'identify' || e.kind === 'logout') });
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, state) => {
    const engine = new IncrementalLearning(state.storage.sql);
    // Reverse the batch itself: the production engine must perform its own sort.
    state.storage.transactionSync(() => engine.accept([...events].reverse(), 200));
    state.storage.transactionSync(() => engine.accept(events, 201)); // Non-adjacent retries.
    state.storage.transactionSync(() => engine.close('site', 2000));
    const outputs = engine.outputs().flatMap(item => item.output.records);
    const samples = outputs.filter(r => r.table_name === 'observations');
    expect(samples).toHaveLength(reference.samples.length);
    for (const sample of reference.samples) expect(samples.find(r => r.record_id === sample.sampleId)!.value).toBeCloseTo(sample.reward, 10);
    const arms = engine.outputs().find(item => item.output.cohort)!.output.cohort!.arms;
    for (const expected of reference.arms) {
      const got = arms.find(arm => arm.experimentId === expected.experimentId && arm.armId === expected.armId)!;
      expect(got.moments.weight).toBeCloseTo(expected.moments.weight, 10);
      expect(meanOf(got.moments)).toBeCloseTo(meanOf(expected.moments), 10);
      expect(stddevOf(got.moments)).toBeCloseTo(stddevOf(expected.moments), 10);
    }
  });
});

it('never regresses latest exposure or identity across batches and never replays a goal', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, state) => {
    const engine = new IncrementalLearning(state.storage.sql), a = { cid: 'browser', uid: 'a' };
    const accept = (events: EyeEvent[], now: number) => state.storage.transactionSync(() => engine.accept(events, now));
    accept([{ kind: 'identify', eventId: 'new-login', occurredAt: 30, subject: a }, exposure('new', 40, 'e', a)], 40);
    const stale = accept([{ kind: 'logout', eventId: 'old-logout', occurredAt: 20, subject: anon }, exposure('old', 10, 'e', a)], 50);
    expect(stale.diagnostics.staleIdentities).toBe(1); expect(stale.diagnostics.staleExposures).toBe(1);
    const early = accept([goal('earlier-goal', 35, 100, a)], 50);
    expect(early.diagnostics.futureExposures).toBe(1);
    accept([goal('accepted', 45, -10, a)], 50);
    accept([goal('earlier-goal', 35, 100, a)], 60);
    state.storage.transactionSync(() => engine.close('site', 2000));
    const observations = engine.outputs().flatMap(item => item.output.records).filter(r => r.table_name === 'observations');
    expect(observations.find(r => r.record_id === 'old')!.value).toBe(0);
    expect(observations.find(r => r.record_id === 'new')!.value).toBeCloseTo(-10 * 2 ** -.05);
  });
});

it('preserves the original goal acceptance decision on Queue retry', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, state) => {
    const engine = new IncrementalLearning(state.storage.sql), g = goal('g', 20, 100);
    expect(state.storage.transactionSync(() => engine.accept([g], 30, () => false)).accepted).toEqual([false]);
    expect(state.storage.transactionSync(() => engine.accept([g], 40, () => true)).accepted).toEqual([false]);
  });
});

it('does not revive an older longer-horizon exposure', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, state) => {
    const engine = new IncrementalLearning(state.storage.sql);
    const accept = (events: EyeEvent[], now: number) => state.storage.transactionSync(() => engine.accept(events, now));
    accept([exposure('old', 0), exposure('latest', 10, 'e', anon, { attributionWindowMs: 5 }), exposure('other', 20, 'f')], 20);
    accept([goal('g', 30, 100)], 30);
    state.storage.transactionSync(() => engine.close('site', 2000));
    const rows = engine.outputs().flatMap(item => item.output.records).filter(r => r.table_name === 'observations');
    expect(rows.find(r => r.record_id === 'other')!.value).toBeCloseTo(100 * 2 ** -.1);
    expect(rows.filter(r => r.record_id !== 'other').every(r => r.value === 0)).toBe(true);
  });
});

it('keeps a completed observation in the attribution denominator without adding another reward to it', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, state) => {
    const engine = new IncrementalLearning(state.storage.sql);
    const short = exposure('short', 0, 'e', anon, { assignment: { ...exposure('short', 0).assignment,
      settings: { ...config, observationWindowMs: 10 } } });
    state.storage.transactionSync(() => engine.accept([short], 0));
    state.storage.transactionSync(() => engine.accept([exposure('open', 10, 'f')], 10));
    state.storage.transactionSync(() => engine.close('site', 20));
    state.storage.transactionSync(() => engine.accept([goal('g', 30, 100)], 30));
    state.storage.transactionSync(() => engine.close('site', 2000));
    const rows = engine.outputs().flatMap(item => item.output.records).filter(r => r.table_name === 'observations');
    expect(rows.find(r => r.record_id === 'short')!.value).toBe(0);
    expect(rows.find(r => r.record_id === 'open')!.value).toBeCloseTo(50 * 2 ** -.2);
  });
});

it('retains compensated signed sums across batches and ignores goals after a deadline without reopening samples', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, state) => {
    const engine = new IncrementalLearning(state.storage.sql);
    const accept = (events: EyeEvent[], now: number) => state.storage.transactionSync(() => engine.accept(events, now));
    accept([exposure('shown', 10, 'e', anon, { eventId: 'a-shown' }), goal('g0', 10, 1e308), goal('g1', 10, 1e308)], 10);
    accept([goal('g2', 10, -1e308)], 11);
    state.storage.transactionSync(() => engine.close('site', 2000));
    const before = engine.outputs();
    expect(before.flatMap(item => item.output.records).find(r => r.table_name === 'observations')!.value).toBe(1e308);
    expect(accept([goal('too-late', 20, 100)], 2001).diagnostics.closedGoals).toBe(1);
    accept([exposure('late-repeat', 20, 'e', anon, { assignment: exposure('shown', 10).assignment, sample: { sampleId: 'shown', startAt: 10 } })], 2002);
    expect(state.storage.transactionSync(() => engine.close('site', 3000))).toBe(0);
  });
});

it('handles more than 10000 related exposures without a raw query or enlarged observation state', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, state) => {
    const engine = new IncrementalLearning(state.storage.sql);
    const e = exposure('shown', 0, 'e', anon, { assignment: { ...exposure('shown', 0).assignment,
      settings: { ...config, observationWindowMs: 100000 } } });
    for (let i = 0; i < 101; i++) state.storage.transactionSync(() => engine.accept(Array.from({ length: 100 }, (_, j) => ({
      ...e, eventId: `exposure-${i * 100 + j}`, occurredAt: i * 100 + j,
    })), i * 100 + 99));
    expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM learning_samples').one().n).toBe(1);
    expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM learning_last').one().n).toBe(1);
    expect(state.storage.transactionSync(() => engine.close('site', 200000))).toBe(1);
  });
});

it('rolls back dedup and reward writes together and bounds cleanup of expired metadata', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, state) => {
    const engine = new IncrementalLearning(state.storage.sql), e = exposure('shown', 10);
    expect(() => state.storage.transactionSync(() => { engine.accept([e], 20); throw new Error('abort'); })).toThrow('abort');
    expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM learning_seen').one().n).toBe(0);
    state.storage.transactionSync(() => engine.accept([e], 20));
    state.storage.transactionSync(() => engine.close('site', 2000));
    engine.acknowledge(engine.outputs().map(item => item.id));
    state.storage.transactionSync(() => engine.prune(RETENTION_MS + 2001));
    expect(engine.nextWake(RETENTION_MS + 2001)).toBeNull();
  });
});

it('closes large populations in bounded durable batches without losing zero-reward samples', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, state) => {
    const engine = new IncrementalLearning(state.storage.sql);
    for (let i = 0; i < 7; i++) state.storage.transactionSync(() => engine.accept(Array.from({ length: 100 }, (_, j) =>
      exposure(`sample-${i * 100 + j}`, 0, 'e', { cid: `c-${i * 100 + j}` })), 0));
    const first = state.storage.transactionSync(() => engine.close('site', 2000));
    expect(first).toBeGreaterThan(0); expect(first).toBeLessThanOrEqual(500);
    expect(first).toBeLessThan(700);
    while (state.storage.transactionSync(() => engine.close('site', 2000)) > 0) { /* Drain bounded batches. */ }
    const records = engine.outputs().flatMap(item => item.output.records);
    expect(records).toHaveLength(700);
    expect(new Set(records.map(row => row.record_id)).size).toBe(700);
    expect(records.every(row => row.value === 0)).toBe(true);
  });
});

it('makes identity retries idempotent without a non-goal ledger and retains late zero observations', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, state) => {
    const engine = new IncrementalLearning(state.storage.sql);
    const accept = (events: EyeEvent[], now: number) => state.storage.transactionSync(() => engine.accept(events, now));
    const logout: IdentityEvent = { kind: 'logout', eventId: 'logout', occurredAt: 20, subject: anon };
    accept([exposure('old', 10)], 10);
    accept([logout], 20);
    accept([exposure('fresh', 30)], 30);
    accept([logout, exposure('old', 10), exposure('late-first', 15, 'other')], 35);
    accept([goal('reward', 40, 10)], 40);
    expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM learning_seen').one().n).toBe(1);
    state.storage.transactionSync(() => engine.close('site', 2000));
    const rows = engine.outputs().flatMap(o => o.output.records);
    expect(rows.find(r => r.record_id === 'fresh')!.value).toBeCloseTo(10 * 2 ** -.1);
    expect(rows.find(r => r.record_id === 'old')!.value).toBe(0);
    expect(rows.find(r => r.record_id === 'late-first')!.value).toBe(0);
  });
});

it('reads transfers and deletions inside a combined transaction and forgets overlays after rollback', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, state) => {
    const engine = new IncrementalLearning(state.storage.sql), uid = { cid: 'browser', uid: 'u' };
    const events: EyeEvent[] = [exposure('first', 10), { kind: 'identify', eventId: 'login', occurredAt: 20, subject: uid },
      goal('uid-reward', 30, 10, uid), { kind: 'logout', eventId: 'logout', occurredAt: 40, subject: anon },
      exposure('discard', 50), { kind: 'logout', eventId: 'logout2', occurredAt: 60, subject: anon }, goal('no-reward', 70, 100)];
    expect(() => state.storage.transactionSync(() => { engine.accept(events, 80); throw Error('abort'); })).toThrow('abort');
    // Same engine instance after rollback: all cached reads/writes must be gone.
    state.storage.transactionSync(() => engine.accept(events, 80));
    state.storage.transactionSync(() => engine.close('site', 2000));
    const rows = engine.outputs().flatMap(o => o.output.records);
    expect(rows.find(r => r.record_id === 'first')!.value).toBeCloseTo(10 * 2 ** -.2);
    expect(rows.find(r => r.record_id === 'discard')!.value).toBe(0);
  });
});

it('reads legacy full exposure references and preserves existing goal decisions during upgrade', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, state) => {
    const engine = new IncrementalLearning(state.storage.sql), e = exposure('legacy', 10);
    state.storage.transactionSync(() => engine.accept([e], 10));
    state.storage.sql.exec('UPDATE learning_last SET data=?', JSON.stringify(e));
    state.storage.sql.exec('INSERT INTO learning_seen VALUES (?, ?, ?)', 'rejected-legacy-goal', 15, 0);
    const restarted = new IncrementalLearning(state.storage.sql);
    expect(state.storage.transactionSync(() => restarted.accept([goal('rejected-legacy-goal', 15, 100)], 20)).accepted).toEqual([false]);
    state.storage.transactionSync(() => restarted.accept([goal('new-goal', 20, 10)], 20));
    state.storage.transactionSync(() => restarted.close('site', 2000));
    expect(restarted.outputs().flatMap(o => o.output.records)[0]!.value).toBeCloseTo(10 * 2 ** -.1);
  });
});

it('combines a hundred contributions into one sample write without altering compensated reward order', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, state) => {
    let sampleWrites = 0;
    const engine = new IncrementalLearning({ exec(query, ...bindings) {
      if (/^(INSERT INTO|UPDATE) learning_samples/.test(query)) sampleWrites++;
      return state.storage.sql.exec(query, ...bindings);
    } });
    state.storage.transactionSync(() => engine.accept([exposure('a-exposure', 10)], 10));
    sampleWrites = 0;
    const goals = Array.from({ length: 100 }, (_, i) => goal(`g${String(i).padStart(3, '0')}`, 10, i === 0 ? 1e16 : i === 99 ? -1e16 : 1));
    state.storage.transactionSync(() => engine.accept(goals, 10));
    expect(sampleWrites).toBe(1);
    state.storage.transactionSync(() => engine.close('site', 2000));
    expect(engine.outputs().flatMap(o => o.output.records)[0]!.value).toBeCloseTo(98, 10);
  });
});
