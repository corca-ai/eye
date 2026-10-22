import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { experimentKey, subjectKey } from '../../src/core/validation.js';
import type { Assignment, Credit, EventEnvelope, EyeEvent, Observation } from '../../src/core/types.js';

async function setup(settings = { minHoldMs: 100_000, observationWindowMs: 10_000, allowedLatenessMs: 0 }) {
  const siteId = crypto.randomUUID(), subject = { cid: 'browser', uid: 'user' }, experimentId = 'layout';
  const experiment = env.EXPERIMENTS.getByName(experimentKey(siteId, experimentId));
  await env.SITES.getByName(siteId).createGoal('value');
  await experiment.create({ experimentId, arms: ['a', 'b'], settings });
  const user = env.SUBJECTS.getByName(subjectKey(siteId, subject));
  const decision = await user.decide(siteId, subject, experimentId);
  if (decision.status !== 'assigned') throw new Error('Expected assignment');
  const send = (event: EyeEvent): Promise<unknown> => user.ingest({ siteId, receivedAt: Date.now(), event });
  const expose = (eventId: string, at: number, assignment = decision.assignment) => send({ kind: 'exposure', eventId, subject, occurredAt: at, assignment });
  const goal = (eventId: string, at: number, value: number) => send({ kind: 'goal', eventId, subject, occurredAt: at, goalId: 'value', value });
  return { siteId, subject, experimentId, experiment, user, assignment: decision.assignment, send, expose, goal };
}
async function observations(user: ReturnType<typeof env.SUBJECTS.getByName>): Promise<Observation[]> {
  return runInDurableObject(user, (_instance, state) => state.storage.sql.exec<{ data: string }>('SELECT data FROM observations ORDER BY start_at').toArray().map(r => JSON.parse(r.data) as Observation));
}
async function credits(user: ReturnType<typeof env.SUBJECTS.getByName>): Promise<Credit[]> {
  return runInDurableObject(user, (_instance, state) => state.storage.sql.exec<{ data: string }>('SELECT data FROM credits ORDER BY goal_id, experiment_id').toArray().map(r => JSON.parse(r.data) as Credit));
}

describe('subject assignments and learning ledger', () => {
  it('replays equal-time Unicode exposure IDs in the same order as SQLite', async () => {
    const s = await setup(), at = s.assignment.assignedAt;
    await s.expose('\u{10000}', at);
    await s.expose('\uE000', at);
    const rows = await observations(s.user);
    expect(rows.find(o => o.status !== 'interrupted')?.observationId).toBe(JSON.stringify([s.assignment.assignmentId, '\uE000']));
  });
  it('preserves the original statistics owner when replay closes a window after uid adoption', async () => {
    const siteId = crypto.randomUUID(), anonymous = { cid: 'before-login' }, experimentId = 'replay';
    await env.EXPERIMENTS.getByName(experimentKey(siteId, experimentId)).create({ experimentId, arms: ['a'], settings: { minHoldMs: 1000, observationWindowMs: 10_000, allowedLatenessMs: 0 } });
    const user = env.SUBJECTS.getByName(subjectKey(siteId, anonymous));
    const decision = await user.decide(siteId, anonymous, experimentId);
    if (decision.status !== 'assigned') throw new Error('Missing assignment');
    const at = decision.assignment.assignedAt;
    const send = (eventId: string) => user.ingest({ siteId, receivedAt: Date.now(), event: { kind: 'exposure', eventId, occurredAt: at, subject: anonymous, assignment: decision.assignment } });
    await send('a'); await send('z');
    const original = (await observations(user))[0]!;
    await user.claimOwner(siteId, { ...anonymous, uid: 'after-login' });
    await runInDurableObject(user, async instance => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(at + 20_000);
      try { await instance.ingest({ siteId, receivedAt: at + 20_000, event: { kind: 'exposure', eventId: 'm', occurredAt: at, subject: anonymous, assignment: decision.assignment } }); }
      finally { clock.mockRestore(); }
    });
    const updated = (await observations(user))[0]!;
    expect(updated.status).toBe('complete');
    expect(updated.subjectKey).toBe(original.subjectKey);
  });
  it('does not let an expired learning correction permanently block an outbox', async () => {
    const s = await setup();
    await s.expose('queued', s.assignment.assignedAt);
    const result = await runInDurableObject(s.user, async (instance, state) => {
      const record = state.storage.sql.exec<{ data: string }>("SELECT data FROM outbox WHERE kind = 'observation' LIMIT 1").one();
      const effect = JSON.parse(record.data);
      effect.observation.endAt = Date.now() - 61 * 86_400_000;
      state.storage.sql.exec("UPDATE outbox SET data = ? WHERE kind = 'observation'", JSON.stringify(effect));
      let error: unknown;
      try { await instance.flush(); } catch (e) { error = e; }
      return { error: error instanceof Error ? error.message : error, pending: state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox').one().n };
    });
    expect(result.error).toBeUndefined(); expect(result.pending).toBe(0);
  });
  it('preserves anonymous source identity in delayed exports after uid claims the home', async () => {
    const s = await setup();
    await s.user.claimOwner(s.siteId, s.subject);
    await s.send({ kind: 'exposure', eventId: 'delayed-anonymous', subject: { cid: s.subject.cid }, occurredAt: s.assignment.assignedAt, assignment: s.assignment });
    const exported = await runInDurableObject(s.user, (_instance, state) => state.storage.sql.exec<{ data: string }>("SELECT data FROM outbox WHERE kind = 'export'").toArray().map(row => JSON.parse(row.data).record));
    const event = exported.find(record => record.record_id === 'delayed-anonymous');
    expect(event.uid).toBeNull(); expect(event.cid).toBe(s.subject.cid);
    const observation = exported.find(record => record.table_name === 'observations');
    expect(observation.uid).toBeNull(); expect(observation.state_key).toBe(event.state_key);
  });
  it('holds assignments across devices, concurrent calls and object eviction', async () => {
    const s = await setup();
    const decisions = await Promise.all(Array.from({ length: 20 }, (_, i) => s.user.decide(s.siteId, { cid: `device-${i}`, uid: 'user' }, s.experimentId)));
    expect(decisions.every(d => d.status === 'assigned' && d.assignment.assignmentId === s.assignment.assignmentId)).toBe(true);
    await evictDurableObject(s.user);
    expect(await s.user.peek(s.experimentId)).toEqual(s.assignment);
    await s.experiment.setArmStatus(s.assignment.armId, 'paused');
    const next = await s.user.decide(s.siteId, s.subject, s.experimentId);
    expect(next.status).toBe('assigned');
    if (next.status === 'assigned') expect(next.assignment.armId).not.toBe(s.assignment.armId);
  });
  it('preserves the configured hold when policy settings change', async () => {
    const s = await setup();
    await s.experiment.updateSettings({ learningHalfLifeMs: 100_000 });
    const next = await s.user.decide(s.siteId, s.subject, s.experimentId);
    expect(next.status === 'assigned' && next.assignment.assignmentId).toBe(s.assignment.assignmentId);
    expect((await s.experiment.getConfig()).generation).toBe(2);
  });
  it('applies each goal once, publishes pending pressure and drains the durable outbox', async () => {
    const s = await setup(), at = s.assignment.assignedAt;
    await s.expose('exposure', at);
    const event: EyeEvent = { kind: 'goal', eventId: 'goal', subject: s.subject, occurredAt: at, goalId: 'value', value: 80 };
    await s.send(event); await s.send(event);
    expect((await observations(s.user))[0]?.reward).toBe(80);
    await s.user.flush();
    const policy = await s.experiment.getPolicy();
    expect(policy.arms.reduce((n, a) => n + a.pending, 0)).toBe(1);
    expect(policy.arms.reduce((n, a) => n + a.weight, 0)).toBe(0);
    const remaining = await runInDurableObject(s.user, (_instance, state) => state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM outbox').one().n);
    expect(remaining).toBe(0);
  });
  it('corrects a goal that arrives before two exposures without duplicating site value', async () => {
    const s = await setup();
    const second = env.EXPERIMENTS.getByName(experimentKey(s.siteId, 'second'));
    await second.create({ experimentId: 'second', arms: ['only'], settings: { minHoldMs: 100_000, observationWindowMs: 10_000, allowedLatenessMs: 0 } });
    const decision = await s.user.decide(s.siteId, s.subject, 'second');
    if (decision.status !== 'assigned') throw new Error('Expected assignment');
    const at = Date.now();
    await s.goal('purchase', at, -100);
    expect(await credits(s.user)).toEqual([]);
    await s.expose('first-exposure', at);
    expect((await credits(s.user))[0]?.baseValue).toBe(-100);
    await s.expose('second-exposure', at, decision.assignment);
    expect((await credits(s.user)).map(c => c.baseValue)).toEqual([-50, -50]);
    expect((await observations(s.user)).map(o => o.reward)).toEqual([-50, -50]);
    const count = await runInDurableObject(s.user, (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM events WHERE kind = 'goal'").one().n);
    expect(count).toBe(1);
  });
  it('rebuilds fixed windows when an older first exposure arrives late', async () => {
    const s = await setup(), at = s.assignment.assignedAt;
    await new Promise(resolve => setTimeout(resolve, 8));
    await s.expose('later', at + 3);
    await s.goal('purchase', at + 4, 10);
    await s.expose('earlier', at);
    const rows = await observations(s.user);
    expect(rows.filter(o => o.status !== 'interrupted')).toHaveLength(1);
    expect(rows.find(o => o.startAt === at)?.reward).toBeGreaterThan(9.99);
    expect(rows.find(o => o.startAt === at + 3)?.status).toBe('interrupted');
    expect((await credits(s.user))[0]?.observationId).toBe(rows.find(o => o.startAt === at)?.observationId);
    await s.user.flush();
    expect((await s.experiment.getPolicy()).arms.reduce((n, a) => n + a.pending, 0)).toBe(1);
  });
  it('counts a completed zero only after the full window, and creates no idle windows', async () => {
    const s = await setup({ minHoldMs: 100_000, observationWindowMs: 10, allowedLatenessMs: 0 });
    await s.expose('zero', s.assignment.assignedAt);
    await new Promise(resolve => setTimeout(resolve, 15));
    await runDurableObjectAlarm(s.user);
    const rows = await observations(s.user);
    expect(rows).toHaveLength(1); expect(rows[0]?.status).toBe('complete'); expect(rows[0]?.reward).toBe(0);
    const policy = await s.experiment.getPolicy();
    expect(policy.arms.reduce((n, a) => n + a.weight, 0)).toBeCloseTo(1, 5);
    expect(policy.arms.reduce((n, a) => n + a.pending, 0)).toBe(0);
    await runDurableObjectAlarm(s.user);
    expect(await observations(s.user)).toHaveLength(1);
  });
  it('keeps last-touch credit after an identity interruption without training on the interrupted window', async () => {
    const s = await setup(), at = s.assignment.assignedAt;
    await s.expose('e', at);
    await s.user.interrupt(s.siteId, s.subject, Date.now());
    await s.goal('after', Date.now(), 10);
    const result = await credits(s.user);
    expect(result).toHaveLength(1);
    expect(result[0]?.learningEligible).toBe(false);
    expect((await observations(s.user))[0]?.status).toBe('interrupted');
    expect(await s.user.peek(s.experimentId)).toBeNull();
  });
});

describe('long-term operational retention', () => {
  it('keeps a pre-horizon last-touch anchor for a delayed goal and schedules no busy cleanup loop', async () => {
    const s = await setup(), day = 86_400_000, now = Date.now();
    await s.user.flush();
    await runInDurableObject(env.SITES.getByName(s.siteId), (_instance, state) => {
      state.storage.sql.exec('UPDATE goal_history SET effective_at = ?', now - 250 * day);
    });
    await runInDurableObject(s.user, (_instance, state) => {
      for (const [id, age] of [['obsolete', 220], ['anchor', 200], ['recent', 1]] as const) {
        const occurredAt = now - age * day;
        const event = { kind: 'exposure', eventId: id, subject: s.subject, occurredAt,
          assignment: { ...s.assignment, assignedAt: now - 250 * day } };
        state.storage.sql.exec('INSERT INTO exposures VALUES (?, ?, ?, ?, ?, ?)', id, s.experimentId, s.assignment.assignmentId, occurredAt, null, JSON.stringify(event));
      }
    });
    await runDurableObjectAlarm(s.user);
    const retained = await runInDurableObject(s.user, async (_instance, state) => ({
      ids: state.storage.sql.exec<{ id: string }>('SELECT id FROM exposures ORDER BY occurred_at').toArray().map(r => r.id),
      alarm: await state.storage.getAlarm(),
    }));
    expect(retained.ids).toEqual(['anchor', 'recent']);
    expect(retained.alarm).toBeGreaterThan(now + 100 * day);
    await s.goal('delayed', now - 30 * day, 100);
    const result = await credits(s.user);
    expect(result).toHaveLength(1);
    expect(result[0]?.exposureId).toBe('anchor');
    expect(result[0]?.experimentCount).toBe(1);
    expect(result[0]?.value).toBeGreaterThan(0);
    expect(result[0]?.learningEligible).toBe(false);
  });
});
