import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { createEye, encodedSize, MAX_BATCH_BYTES } from '../../src/client.js';
import { EyeWorker } from '../../src/runtime/service.js';
import { subjectKey } from '../../src/core/validation.js';
import { identityKey } from '../../src/runtime/identity.js';
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
    const anonymous = await s.eye.decide({ subject: { cid: 'browser' }, experimentId: 'checkout' });
    if (anonymous.status !== 'assigned') throw new Error('Missing anonymous decision');
    const adopted = await s.eye.decide({ subject: { cid: 'browser', uid: 'alice' }, experimentId: 'checkout' });
    if (adopted.status !== 'assigned') throw new Error('Missing uid decision');
    expect(adopted.assignment.assignmentId).toBe(anonymous.assignment.assignmentId);
    const other = await s.eye.decide({ subject: { cid: 'second-browser', uid: 'alice' }, experimentId: 'checkout' });
    expect(other.status === 'assigned' && other.assignment.assignmentId).toBe(adopted.assignment.assignmentId);
    const anonymousHome = await env.IDENTITIES.getByName(identityKey(s.siteId, 'cid', 'browser')).anonymousHome(s.siteId, 'browser', Date.now());
    expect(await env.SUBJECTS.getByName(anonymousHome).peek('checkout')).toBeNull();
    await waitOnExecutionContext(s.ctx);
  });
  it('keeps the existing uid arm when a browser holds a different active arm', async () => {
    const s = await setup();
    await s.eye.experiments.pauseArm('checkout', 'b');
    const uidChoice = await s.eye.decide({ subject: { cid: 'first', uid: 'known' }, experimentId: 'checkout' });
    await s.eye.experiments.resumeArm('checkout', 'b');
    await s.eye.experiments.pauseArm('checkout', 'a');
    const browserChoice = await s.eye.decide({ subject: { cid: 'conflict' }, experimentId: 'checkout' });
    await s.eye.experiments.resumeArm('checkout', 'a');
    if (uidChoice.status !== 'assigned' || browserChoice.status !== 'assigned') throw new Error('Missing choices');
    expect(uidChoice.assignment.armId).toBe('a'); expect(browserChoice.assignment.armId).toBe('b');
    const result = await s.eye.decide({ subject: { cid: 'conflict', uid: 'known' }, experimentId: 'checkout' });
    expect(result.status === 'assigned' && result.assignment.assignmentId).toBe(uidChoice.assignment.assignmentId);
    await waitOnExecutionContext(s.ctx);
  });
  it('preserves an anonymous observation when a new uid adopts the same arm, so signup reward is learned', async () => {
    const s = await setup();
    await s.eye.experiments.update('checkout', { observationWindowMs: 100 });
    const anonymous = await s.eye.decide({ subject: { cid: 'signup-browser' }, experimentId: 'checkout' });
    if (anonymous.status !== 'assigned') throw new Error('Missing anonymous assignment');
    await consume([{ siteId: s.siteId, receivedAt: Date.now(), event: {
      kind: 'exposure', eventId: 'signup-shown', subject: { cid: 'signup-browser' },
      assignment: anonymous.assignment, occurredAt: anonymous.assignment.assignedAt,
    } }]);
    const loggedIn = await s.eye.decide({ subject: { cid: 'signup-browser', uid: 'new-account' }, experimentId: 'checkout' });
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
    const before = await s.eye.decide({ subject: { cid: 'delayed-browser' }, experimentId: 'checkout' });
    if (before.status !== 'assigned') throw new Error('Missing decision');
    const at = Date.now();
    // Keep the exposure in the SDK until the identity transition has completed.
    await s.eye.decide({ subject: { cid: 'delayed-browser', uid: 'joined' }, experimentId: 'checkout' });
    expect(s.eye.expose({ subject: { cid: 'delayed-browser' }, decision: before, eventId: 'late-shown', occurredAt: at }).accepted).toBe(true);
    expect(s.eye.goal({ subject: { cid: 'delayed-browser', uid: 'joined' }, goalId: 'purchase', eventId: 'late-signup', occurredAt: at, value: 44 }).accepted).toBe(true);
    await s.eye.flush(); await waitOnExecutionContext(s.ctx);
    await expect.poll(async () => (await s.eye.experiments.policy('checkout')).arms.reduce((sum, arm) => sum + arm.weight * arm.meanReward, 0), { timeout: 5000 }).toBeGreaterThan(43.9);
  });
  it('delivers exposure and goal through the actual local Queue into the learning ledger', async () => {
    const s = await setup(), subject = { cid: 'browser', uid: 'user' };
    const decision = await s.eye.decide({ subject, experimentId: 'checkout' });
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
