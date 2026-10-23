import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { createEye, encodedSize, MAX_BATCH_BYTES } from '../../src/client.js';
import { EyeWorker } from '../../src/runtime/service.js';
import { DAY_MS, experimentKey, subjectKey } from '../../src/core/validation.js';
import { identityKey } from '../../src/runtime/identity.js';
import type { SubjectObject } from '../../src/runtime/subject.js';
import type { EventEnvelope, Observation } from '../../src/core/types.js';

async function setup() {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext();
  const eye = createEye({ siteId, ctx, service: exports.default });
  await eye.goals.create('purchase');
  await eye.experiments.create({ experimentId: 'checkout', arms: ['a', 'b'], settings: { minHoldMs: 100_000, observationWindowMs: 10_000, allowedLatenessMs: 0 } });
  return { siteId, ctx, eye };
}
async function consume(envelopes: EventEnvelope[]) {
  const ctx = createExecutionContext(), worker = new EyeWorker(ctx, env);
  const batch = createMessageBatch('eye-events', envelopes.map(body => ({ id: crypto.randomUUID(), timestamp: Date.now(), attempts: 1, body })));
  await worker.queue(batch);
  return getQueueResult(batch, ctx);
}

describe('public client and Service Binding', () => {
  it('preserves omitted correction deadlines through the public client when recreating legacy experiments', async () => {
    const siteId = crypto.randomUUID(), ctx = createExecutionContext();
    const eye = createEye({ siteId, ctx, service: exports.default });
    for (const allowedLatenessMs of [0, 8 * DAY_MS]) {
      const input = { experimentId: `legacy-${allowedLatenessMs}`, arms: ['a'], settings: { minHoldMs: 0, allowedLatenessMs } };
      await eye.experiments.create({ ...input, settings: { ...input.settings, correctionWindowMs: 60 * DAY_MS } });
      const stub = env.EXPERIMENTS.getByName(experimentKey(siteId, input.experimentId));
      await runInDurableObject(stub, (_instance, state) => {
        for (const key of ['definition', 'config']) {
          const stored = state.storage.kv.get<{ settings: Record<string, unknown> }>(key)!;
          delete stored.settings.correctionWindowMs;
          state.storage.kv.put(key, stored);
        }
      });
      const recreated = await eye.experiments.create(input);
      expect(recreated.settings.correctionWindowMs).toBeUndefined();
      expect(recreated.generation).toBe(1);
    }
    const created = await eye.experiments.create({ experimentId: 'new', arms: ['a'], settings: { minHoldMs: 0 } });
    expect(created.settings.correctionWindowMs).toBe(7 * DAY_MS);
    await waitOnExecutionContext(ctx);
  });
  it('validates immediately and schedules one nonblocking batch for the request', async () => {
    const ctx = createExecutionContext(), service = new EyeWorker(ctx, env);
    let finish!: () => void;
    const accepted = new Promise<void>(resolve => { finish = resolve; });
    const send = vi.spyOn(service, 'ingest').mockReturnValue(accepted);
    const eye = createEye({ siteId: 'site', ctx, service });
    expect(eye.track({ subject: { cid: 'c' }, name: 'page' }).accepted).toBe(true);
    expect(eye.goal({ subject: { cid: 'c' }, goalId: 'purchase', value: NaN }).accepted).toBe(false);
    expect(eye.goal({ subject: { cid: 'c' }, goalId: 'purchase', value: -100 }).accepted).toBe(true);
    expect(send).not.toHaveBeenCalled();
    const flushing = eye.flush();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toHaveLength(2);
    finish(); await flushing; await waitOnExecutionContext(ctx);
  });
  it('batches by encoded byte size and continues after a failed batch', async () => {
    const ctx = createExecutionContext(), service = new EyeWorker(ctx, env);
    const batches: EventEnvelope[][] = [];
    let calls = 0;
    vi.spyOn(service, 'ingest').mockImplementation(async batch => {
      batches.push([...batch]);
      if (++calls === 1) throw new Error('Queue unavailable');
    });
    const failures: unknown[] = [];
    const eye = createEye({ siteId: 'site', ctx, service, onError(error) { failures.push(error); } });
    for (let i = 0; i < 10; i++) eye.track({ subject: { cid: 'c' }, name: 'large', attributes: { text: 'a'.repeat(70_000) } });
    await expect(eye.flush()).rejects.toThrow('Queue unavailable');
    await waitOnExecutionContext(ctx);
    expect(batches.map(b => b.length)).toEqual([3, 3, 3, 1]);
    expect(batches.every(b => b.reduce((n, event) => n + encodedSize(event) + 200, 0) <= MAX_BATCH_BYTES)).toBe(true);
    expect(failures).toHaveLength(1);
  });
  it('uses uid preferences over conflicting cid holds and adopts a cid arm for a new uid', async () => {
    const s = await setup();
    const anonymous = await s.eye.decideConsistent({ subject: { cid: 'browser' }, experimentId: 'checkout' });
    if (anonymous.status !== 'assigned') throw new Error('Missing anonymous decision');
    const adopted = await s.eye.decideConsistent({ subject: { cid: 'browser', uid: 'alice' }, experimentId: 'checkout' });
    if (adopted.status !== 'assigned') throw new Error('Missing uid decision');
    expect(adopted.assignment.assignmentId).toBe(anonymous.assignment.assignmentId);
    const other = await s.eye.decideConsistent({ subject: { cid: 'second-browser', uid: 'alice' }, experimentId: 'checkout' });
    expect(other.status === 'assigned' && other.assignment.assignmentId).toBe(adopted.assignment.assignmentId);
    const anonymousHome = await env.IDENTITIES.getByName(identityKey(s.siteId, 'cid', 'browser')).anonymousHome(s.siteId, 'browser', Date.now());
    expect(await env.SUBJECTS.getByName(anonymousHome).peek('checkout')).toBeNull();
    await waitOnExecutionContext(s.ctx);
  });
  it('keeps the existing uid arm when a browser holds a different active arm', async () => {
    const s = await setup();
    await s.eye.experiments.pauseArm('checkout', 'b');
    const uidChoice = await s.eye.decideConsistent({ subject: { cid: 'first', uid: 'known' }, experimentId: 'checkout' });
    await s.eye.experiments.resumeArm('checkout', 'b');
    await s.eye.experiments.pauseArm('checkout', 'a');
    const browserChoice = await s.eye.decideConsistent({ subject: { cid: 'conflict' }, experimentId: 'checkout' });
    await s.eye.experiments.resumeArm('checkout', 'a');
    if (uidChoice.status !== 'assigned' || browserChoice.status !== 'assigned') throw new Error('Missing choices');
    expect(uidChoice.assignment.armId).toBe('a'); expect(browserChoice.assignment.armId).toBe('b');
    const result = await s.eye.decideConsistent({ subject: { cid: 'conflict', uid: 'known' }, experimentId: 'checkout' });
    expect(result.status === 'assigned' && result.assignment.assignmentId).toBe(uidChoice.assignment.assignmentId);
    await waitOnExecutionContext(s.ctx);
  });
  it('preserves an anonymous observation when a new uid adopts the same arm, so signup reward is learned', async () => {
    const s = await setup();
    await s.eye.experiments.update('checkout', { observationWindowMs: 100 });
    const anonymous = await s.eye.decideConsistent({ subject: { cid: 'signup-browser' }, experimentId: 'checkout' });
    if (anonymous.status !== 'assigned') throw new Error('Missing anonymous assignment');
    await consume([{ siteId: s.siteId, receivedAt: Date.now(), event: {
      kind: 'exposure', eventId: 'signup-shown', subject: { cid: 'signup-browser' },
      assignment: anonymous.assignment, occurredAt: anonymous.assignment.assignedAt,
    } }]);
    const loggedIn = await s.eye.decideConsistent({ subject: { cid: 'signup-browser', uid: 'new-account' }, experimentId: 'checkout' });
    expect(loggedIn.status === 'assigned' && loggedIn.assignment.armId).toBe(anonymous.assignment.armId);
    // Event time belongs inside the observation independently of RPC/test runner latency.
    // Using Date.now() here made busy machines legitimately produce outside-window credit.
    const at = anonymous.assignment.assignedAt;
    await consume([{ siteId: s.siteId, receivedAt: Date.now(), event: {
      kind: 'goal', eventId: 'signup-goal', goalId: 'purchase', subject: { cid: 'signup-browser', uid: 'new-account' }, occurredAt: at, value: 50,
    } }]);
    await expect.poll(async () => {
      const policy = await s.eye.experiments.policy('checkout');
      return policy.arms.reduce((sum, arm) => sum + arm.weight * arm.meanReward, 0);
    }, { timeout: 3000 }).toBeGreaterThan(49);
  });
  it('routes a delayed anonymous exposure to the same observation home after login', async () => {
    const s = await setup();
    await s.eye.experiments.update('checkout', { observationWindowMs: 100 });
    const before = await s.eye.decideConsistent({ subject: { cid: 'delayed-browser' }, experimentId: 'checkout' });
    if (before.status !== 'assigned') throw new Error('Missing decision');
    const at = Date.now();
    // Keep the exposure in the SDK until the identity transition has completed.
    await s.eye.decideConsistent({ subject: { cid: 'delayed-browser', uid: 'joined' }, experimentId: 'checkout' });
    expect(s.eye.expose({ subject: { cid: 'delayed-browser' }, decision: before, eventId: 'late-shown', occurredAt: at }).accepted).toBe(true);
    expect(s.eye.goal({ subject: { cid: 'delayed-browser', uid: 'joined' }, goalId: 'purchase', eventId: 'late-signup', occurredAt: at, value: 44 }).accepted).toBe(true);
    await s.eye.flush(); await waitOnExecutionContext(s.ctx);
    await expect.poll(async () => (await s.eye.experiments.policy('checkout')).arms.reduce((sum, arm) => sum + arm.weight * arm.meanReward, 0), { timeout: 5000 }).toBeGreaterThan(43.9);
  });
  it('delivers exposure and goal through the actual local Queue into the learning ledger', async () => {
    const s = await setup(), subject = { cid: 'browser', uid: 'user' };
    const decision = await s.eye.decideConsistent({ subject, experimentId: 'checkout' });
    if (decision.status !== 'assigned') throw new Error('Missing decision');
    const at = Date.now();
    expect(s.eye.expose({ subject, decision, eventId: 'shown', occurredAt: at }).accepted).toBe(true);
    expect(s.eye.goal({ subject, goalId: 'purchase', eventId: 'paid', occurredAt: at, value: 42 }).accepted).toBe(true);
    await s.eye.flush(); await waitOnExecutionContext(s.ctx);
    const home = await env.IDENTITIES.getByName(identityKey(s.siteId, 'uid', subject.uid)).uidHome(s.siteId, subject.uid);
    const target = env.SUBJECTS.getByName(home);
    await expect.poll(async () => runInDurableObject(target, (_instance, state) => state.storage.sql.exec<{ data: string }>('SELECT data FROM observations').toArray().map(r => (JSON.parse(r.data) as Observation).reward)), { timeout: 5000 }).toEqual([42]);
    await target.flush();
    expect((await s.eye.experiments.policy('checkout')).arms.reduce((n, a) => n + a.pending, 0)).toBe(1);
  });
});

describe('identity event consumption', () => {
  it('preserves login intervals, ends links on logout and keeps history after account switching', async () => {
    const s = await setup(), cid = 'shared';
    const start = Date.now();
    await new Promise(resolve => setTimeout(resolve, 6));
    const events: EventEnvelope[] = [
      { siteId: s.siteId, receivedAt: Date.now(), event: { kind: 'identify', eventId: 'a', occurredAt: start, subject: { cid, uid: 'alice' } } },
      { siteId: s.siteId, receivedAt: Date.now(), event: { kind: 'logout', eventId: 'b', occurredAt: start + 1, subject: { cid } } },
      { siteId: s.siteId, receivedAt: Date.now(), event: { kind: 'identify', eventId: 'c', occurredAt: start + 2, subject: { cid, uid: 'bob' } } },
    ];
    const result = await consume([events[2]!, events[0]!, events[1]!]);
    expect(result.retryMessages).toEqual([]);
    const anonymous = env.SUBJECTS.getByName(JSON.stringify([s.siteId, 'identity-timeline', cid]));
    const links = await runInDurableObject(anonymous, (_instance, state) => state.storage.sql.exec<{ data: string }>('SELECT data FROM identity_links ORDER BY id').toArray().map(r => JSON.parse(r.data)));
    expect(links).toEqual([
      { linkId: 'a', cid, uid: 'alice', linkedFrom: start, linkedUntil: start + 1, status: 'active' },
      { linkId: 'c', cid, uid: 'bob', linkedFrom: start + 2, linkedUntil: null, status: 'active' },
    ]);
    expect((await consume(events)).retryMessages).toEqual([]);
  });
});

describe('queued analytics logs', () => {
  it('sends ready logs without waiting for a blocked learning RPC in the same batch', async () => {
    const s = await setup(), at = Date.now();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow = env.SUBJECTS.getByName(subjectKey(s.siteId, { cid: 'slow' }));
    await runInDurableObject(slow, instance => {
      // Restrict the gate to this event; alarms/other objects share the prototype.
      const prototype = Object.getPrototypeOf(instance) as SubjectObject;
      const original = prototype.ingest;
      vi.spyOn(prototype, 'ingest').mockImplementation(async function (this: SubjectObject, ...args) {
        if (args[0].siteId === s.siteId && args[0].event.eventId === 'slow-goal') await gate;
        return original.apply(this, args);
      });
    });
    const send = vi.spyOn(env.ANALYTICS, 'send').mockResolvedValue();
    const processing = consume([
      { siteId: s.siteId, receivedAt: at, event: { kind: 'goal', eventId: 'slow-goal', occurredAt: at, subject: { cid: 'slow' }, goalId: 'purchase', value: 1 } },
      { siteId: s.siteId, receivedAt: at, event: { kind: 'track', eventId: 'ready-log', occurredAt: at, subject: { cid: 'ready' }, name: 'page' } },
    ]);
    try {
      await expect.poll(() => send.mock.calls.flatMap(([records]) => records).some(r => r.site_id === s.siteId && r.record_id === 'ready-log'), { timeout: 1000 }).toBe(true);
    } finally {
      release(); await processing;
      send.mockRestore();
      await runInDurableObject(slow, instance => { vi.mocked((Object.getPrototypeOf(instance) as SubjectObject).ingest).mockRestore(); });
      await waitOnExecutionContext(s.ctx);
    }
  });
  it('establishes a uid home on its first track and shares it with later decisions', async () => {
    const s = await setup(), at = Date.now(), subject = { cid: 'new-browser', uid: 'first-track-user' };
    const send = vi.spyOn(env.ANALYTICS, 'send').mockResolvedValue();
    try {
      await consume([{ siteId: s.siteId, receivedAt: at, event: { kind: 'track', eventId: 'first-log', occurredAt: at, subject, name: 'landing' } }]);
      const record = send.mock.calls.flatMap(([records]) => records).find(r => r.site_id === s.siteId && r.table_name === 'events')!;
      const decision = await s.eye.decideConsistent({ subject, experimentId: 'checkout' });
      if (decision.status !== 'assigned' || !decision.routingKey) throw new Error('Missing decision');
      expect(record.uid).toBe(subject.uid);
      expect(record.state_key).toBe(env.SUBJECTS.idFromName(decision.routingKey).toString());
    } finally { send.mockRestore(); await waitOnExecutionContext(s.ctx); }
  });
  it('rejects an oversized queued envelope without poisoning valid logs in the batch', async () => {
    const siteId = crypto.randomUUID(), at = Date.now();
    const send = vi.spyOn(env.ANALYTICS, 'send').mockResolvedValue();
    try {
      const make = (eventId: string, text: string): EventEnvelope => ({ siteId, receivedAt: at,
        event: { kind: 'track', eventId, occurredAt: at, subject: { cid: 'input' }, name: 'page', attributes: { text } },
      });
      expect((await consume([make('too-large', 'a'.repeat(100_000)), make('valid', 'small')])).retryMessages).toEqual([]);
      expect(send.mock.calls.flatMap(([records]) => records.filter(r => r.site_id === siteId && r.table_name === 'events').map(r => r.record_id))).toEqual(['valid']);
    } finally { send.mockRestore(); }
  });
  it('exports a batch directly with stable event IDs, source identity and the learning cohort key', async () => {
    const siteId = crypto.randomUUID(), now = Date.now(), subject = { cid: 'logs' };
    const send = vi.spyOn(env.ANALYTICS, 'send').mockResolvedValue();
    try {
      const envelopes: EventEnvelope[] = Array.from({ length: 100 }, (_, i) => ({ siteId, receivedAt: now,
        event: { kind: 'track', eventId: `event:${i}`, occurredAt: now, subject, name: 'page', attributes: { category: 'books' } },
      }));
      expect((await consume(envelopes)).retryMessages).toEqual([]);
      const calls = () => send.mock.calls.map(([records]) => records).filter(records => records.some(r => r.site_id === siteId));
      expect(calls()).toHaveLength(1);
      const records = calls()[0]!.filter(r => r.table_name === 'events');
      expect(records).toHaveLength(100);
      expect(new Set(records.map(r => r.record_id))).toEqual(new Set(envelopes.map(e => e.event.eventId)));
      for (const record of records) expect(record).toMatchObject({
        site_id: siteId, cid: subject.cid, uid: null, revision: 1, received_at: now, occurred_at: now,
        state_key: env.SUBJECTS.idFromName(subjectKey(siteId, subject)).toString(),
        attributes_json: '{"category":"books"}', status: 'accepted',
      });
      // At-least-once delivery preserves the key used by analytics deduplication.
      await consume([envelopes[0]!]);
      expect(calls()[1]![0]).toEqual(records.find(r => r.record_id === 'event:0'));
    } finally { send.mockRestore(); }
  });
  it('retries only logs whose Stream send failed while learning succeeds in the same batch', async () => {
    const s = await setup(), subject = { cid: 'mixed' };
    const decision = await s.eye.decideConsistent({ subject, experimentId: 'checkout' });
    if (decision.status !== 'assigned') throw new Error('Missing decision');
    const at = Date.now();
    const send = vi.spyOn(env.ANALYTICS, 'send').mockRejectedValue(new Error('Stream unavailable'));
    try {
      const ctx = createExecutionContext(), worker = new EyeWorker(ctx, env);
      const envelopes: EventEnvelope[] = [
        { siteId: s.siteId, receivedAt: at, event: { kind: 'track', eventId: 'log', occurredAt: at, subject, name: 'page' } },
        { siteId: s.siteId, receivedAt: at, event: { kind: 'exposure', eventId: 'seen', occurredAt: at, subject, assignment: decision.assignment, routingKey: decision.routingKey ?? subjectKey(s.siteId, subject) } },
        { siteId: s.siteId, receivedAt: at, event: { kind: 'goal', eventId: 'paid', occurredAt: at, subject, goalId: 'purchase', value: 42 } },
      ];
      const batch = createMessageBatch('eye-events', envelopes.map((body, i) => ({ id: `msg:${i}`, timestamp: at, attempts: 1, body })));
      await worker.queue(batch);
      const result = await getQueueResult(batch, ctx);
      expect(result.retryMessages.map(m => m.msgId)).toEqual(['msg:0']);
      const target = env.SUBJECTS.getByName(decision.routingKey ?? subjectKey(s.siteId, subject));
      const rewards = await runInDurableObject(target, (_instance, state) => state.storage.sql.exec<{ data: string }>('SELECT data FROM observations').toArray().map(r => (JSON.parse(r.data) as Observation).reward));
      expect(rewards).toEqual([42]);
    } finally { send.mockRestore(); await waitOnExecutionContext(s.ctx); }
  });
  it('keeps successful byte-sized groups acknowledged when another group fails', async () => {
    const siteId = crypto.randomUUID(), at = Date.now();
    let failed = false;
    const send = vi.spyOn(env.ANALYTICS, 'send').mockImplementation(async records => {
      if (!records.some(r => r.site_id === siteId)) return;
      if (!failed) { failed = true; throw new Error('temporary'); }
    });
    try {
      const ctx = createExecutionContext(), worker = new EyeWorker(ctx, env);
      const batch = createMessageBatch('eye-events', Array.from({ length: 100 }, (_, i) => ({
        id: `large:${i}`, timestamp: at, attempts: 1,
        body: { siteId, receivedAt: at, event: { kind: 'track', eventId: `large:${i}`, occurredAt: at, subject: { cid: 'large' }, name: 'large', attributes: { text: 'a'.repeat(70_000) } } },
      })));
      await worker.queue(batch);
      const result = await getQueueResult(batch, ctx);
      const calls = send.mock.calls.map(([records]) => records).filter(records => records.some(r => r.site_id === siteId));
      expect(calls.length).toBeGreaterThan(1);
      for (const records of calls) expect(encodedSize(records)).toBeLessThanOrEqual(4_500_000);
      expect(new Set(result.retryMessages.map(m => m.msgId))).toEqual(new Set(calls[0]!.filter(r => r.table_name === 'events').map(r => r.record_id)));
      expect(result.retryMessages.length).toBeLessThan(100);
    } finally { send.mockRestore(); }
  });
  it('retains the anonymous cohort key after uid adoption without rewriting the source identity', async () => {
    const s = await setup(), subject = { cid: 'before' };
    const anonymous = await s.eye.decideConsistent({ subject, experimentId: 'checkout' });
    if (anonymous.status !== 'assigned') throw new Error('Missing decision');
    const at = anonymous.assignment.assignedAt;
    // Ensure the anonymous event is strictly before the login epoch boundary.
    await new Promise(resolve => setTimeout(resolve, 2));
    await s.eye.decideConsistent({ subject: { ...subject, uid: 'account' }, experimentId: 'checkout' });
    const send = vi.spyOn(env.ANALYTICS, 'send').mockResolvedValue();
    try {
      await consume([{ siteId: s.siteId, receivedAt: Date.now(), event: { kind: 'track', eventId: 'late-log', occurredAt: at, subject, name: 'page' } }]);
      const record = send.mock.calls.flatMap(([records]) => records).find(r => r.site_id === s.siteId && r.table_name === 'events')!;
      expect(record.uid).toBeNull();
      expect(record.subject_key).toBe(subjectKey(s.siteId, subject));
      expect(record.state_key).toBe(env.SUBJECTS.idFromName(anonymous.routingKey ?? subjectKey(s.siteId, subject)).toString());
    } finally { send.mockRestore(); await waitOnExecutionContext(s.ctx); }
  });
});


it('coalesces adjacent same-time goals and retries valid neighbours individually after an ID conflict', async () => {
  const { siteId, eye, ctx } = await setup(), subject = { cid: 'grouped-goals' };
  const decision = await eye.decideConsistent({ subject, experimentId: 'checkout' });
  if (decision.status !== 'assigned') throw new Error('Missing assignment');
  const at = Date.now();
  const exposure: EventEnvelope = { siteId, receivedAt: at, event: { kind: 'exposure', eventId: 'e', occurredAt: at, subject, assignment: decision.assignment, routingKey: decision.routingKey! } };
  await consume([exposure]);
  const goal = (eventId: string, value: number): EventEnvelope => ({ siteId, receivedAt: at, event: { kind: 'goal', eventId, occurredAt: at, subject, goalId: 'purchase', value } });
  const target = env.SUBJECTS.getByName(decision.routingKey!);
  const before = await runInDurableObject(target, (_instance, state) => JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM observations').one().data) as Observation);
  const batch = Array.from({ length: 10 }, (_, i) => goal(`g${i}`, 1));
  expect((await consume(batch)).retryMessages).toEqual([]);
  const after = await runInDurableObject(target, (_instance, state) => JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM observations').one().data) as Observation);
  expect(after.reward).toBe(10); expect(after.revision).toBe(before.revision + 1);
  expect((await consume([goal('valid', 5), goal('g0', 99)])).retryMessages).toEqual([]);
  const final = await runInDurableObject(target, (_instance, state) => JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM observations').one().data) as Observation);
  expect(final.reward).toBe(15);
  await waitOnExecutionContext(ctx);
});
