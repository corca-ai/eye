import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, evictDurableObject, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createEye } from '../../src/client.js';
import { experimentKey } from '../../src/core/validation.js';
import type { Decision, EventEnvelope, Observation } from '../../src/core/types.js';
function assigned(d: Decision) { if (d.status !== 'assigned' || !d.routingKey) throw new Error('Missing assignment'); return d as typeof d & { routingKey: string }; }

it('adopts only missing uid experiments, keeps rewards and forwards delayed/duplicate source events', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext(), eye = createEye({ siteId, ctx, service: exports.default });
  await eye.goals.create('purchase');
  for (const experimentId of ['button', 'checkout']) await eye.experiments.create({ experimentId, arms: ['a'], settings: { minHoldMs: 100_000 } });
  const uid = { cid: 'phone', uid: 'alice' }, cid = { cid: 'desktop' };
  const button = assigned(await eye.decideConsistent({ subject: uid, experimentId: 'button' }));
  const checkout = assigned(await eye.decideConsistent({ subject: cid, experimentId: 'checkout' }));
  const source = env.SUBJECTS.getByName(checkout.routingKey), target = env.SUBJECTS.getByName(button.routingKey);
  const at = Date.now();
  const exposure = (decision: typeof button, subject: typeof cid, eventId: string): EventEnvelope => ({ siteId, receivedAt: at, event: { kind: 'exposure', eventId, occurredAt: at, subject, assignment: decision.assignment } });
  await target.ingest(exposure(button, uid, 'button-exposure'));
  await source.ingest(exposure(checkout, cid, 'checkout-exposure'));
  const before: EventEnvelope = { siteId, receivedAt: at, event: { kind: 'goal', eventId: 'before-login', occurredAt: at, subject: cid, goalId: 'purchase', value: 30 } };
  await source.ingest(before);
  await new Promise(resolve => setTimeout(resolve, 2));
  // Simulate losing the coordinator after freezing the source and copying one page.
  await source.freezeTransfer(siteId, { ...cid, uid: 'alice' }, checkout.routingKey, button.routingKey, Date.now());
  const page = await runInDurableObject(source, (_instance, state) => state.storage.sql.exec<{ rowid: number; id: string; experiment_id: string; data: string }>('SELECT rowid, * FROM assignments').toArray().map(({ rowid, ...row }) => ({ id: rowid, data: JSON.stringify(row) })));
  await target.stageTransfer(checkout.routingKey, 'assignments', page);
  await evictDurableObject(source); await evictDurableObject(target);
  const adopted = assigned(await eye.decideConsistent({ subject: { ...cid, uid: 'alice' }, experimentId: 'checkout' }));
  expect(adopted.assignment).toEqual(checkout.assignment);
  expect(adopted.routingKey).toBe(button.routingKey);
  expect((await source.ingest(before)).status).toBe('duplicate');
  const later = Date.now();
  await target.ingest({ siteId, receivedAt: later, event: { kind: 'goal', eventId: 'after-login', occurredAt: later, subject: { ...cid, uid: 'alice' }, goalId: 'purchase', value: 100 } });
  // A pre-login goal arriving after transfer must not credit the unrelated uid experiment.
  await source.ingest({ ...before, event: { ...before.event, eventId: 'late-before-login' } });
  await runInDurableObject(target, (_instance, state) => {
    const observations = state.storage.sql.exec<{ data: string }>('SELECT data FROM observations').toArray().map(r => JSON.parse(r.data) as Observation);
    expect(observations.find(o => o.experimentId === 'checkout')).toMatchObject({ assignmentId: checkout.assignment.assignmentId, startAt: at, status: 'pending' });
    expect(observations.find(o => o.experimentId === 'checkout')!.reward).toBeCloseTo(110, 2);
    expect(observations.find(o => o.experimentId === 'button')!.reward).toBeCloseTo(50, 2);
  });
  // Repeating the login cannot duplicate the imported reward.
  expect(assigned(await eye.decideConsistent({ subject: { ...cid, uid: 'alice' }, experimentId: 'checkout' })).assignment.assignmentId).toBe(checkout.assignment.assignmentId);
  await runInDurableObject(source, async (instance, state) => {
    await instance.alarm();
    for (const table of ['events', 'exposures', 'observations', 'assignments', 'credits', 'outbox', 'origins']) {
      expect(state.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n).toBe(0);
    }
    expect(state.storage.kv.get('transferReady')).toBe(true);
  });
  expect((await source.ingest(before)).status).toBe('duplicate');
  await waitOnExecutionContext(ctx);
});

it('makes experiment and arm deletion permanent while retaining configuration and history', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext(), eye = createEye({ siteId, ctx, service: exports.default });
  await eye.experiments.create({ experimentId: 'exp', arms: ['a', 'b'], settings: { minHoldMs: 100_000 } });
  const subject = { cid: 'c' }, first = assigned(await eye.decideConsistent({ subject, experimentId: 'exp' }));
  await eye.experiments.pause('exp');
  expect((await eye.decideConsistent({ subject, experimentId: 'exp' })).status).toBe('no_active_arm');
  await eye.experiments.resume('exp');
  await eye.experiments.deleteArm('exp', first.assignment.armId);
  expect(assigned(await eye.decideConsistent({ subject, experimentId: 'exp' })).assignment.armId).not.toBe(first.assignment.armId);
  const stub = env.EXPERIMENTS.getByName(experimentKey(siteId, 'exp'));
  await runInDurableObject(stub, instance => {
    expect(() => instance.addArm(first.assignment.armId)).toThrow('cannot be reused');
    expect(() => instance.setArmStatus(first.assignment.armId, 'active')).toThrow('cannot be resumed');
  });
  await eye.experiments.delete('exp');
  expect((await eye.experiments.get('exp')).status).toBe('deleted');
  expect((await eye.decideConsistent({ subject, experimentId: 'exp' })).status).toBe('no_active_arm');
  await runInDurableObject(stub, instance => {
    expect(() => instance.setStatus('active')).toThrow('cannot be resumed');
    expect(() => instance.create({ experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0 } })).toThrow('cannot be reused');
  });
  await waitOnExecutionContext(ctx);
});

it('prepares reusable state without allowing an unacknowledged exposure to trigger early reassignment', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext();
  const eye = createEye({ siteId, ctx, service: exports.default, decisions: { secret: 'test-decision-secret-longer-than-32-bytes' } });
  await eye.experiments.create({ experimentId: 'exp', arms: ['a', 'b'], settings: { minHoldMs: 0 } });
  const input = { subject: { cid: 'c' }, experimentId: 'exp' };
  const prepared = await eye.prepare(input), first = assigned(prepared.decision);
  expect(assigned(await eye.decide(input)).assignment.assignmentId).toBe(first.assignment.assignmentId);
  // Even a competing central preparation cannot replace the lease before queued exposure arrives.
  expect(assigned(await eye.decideConsistent(input)).assignment.assignmentId).toBe(first.assignment.assignmentId);
  const at = Date.now();
  await env.SUBJECTS.getByName(first.routingKey).ingest({ siteId, receivedAt: at, event: { kind: 'exposure', eventId: 'late-exposure', occurredAt: at, subject: input.subject, assignment: first.assignment } });
  await runInDurableObject(env.SUBJECTS.getByName(first.routingKey), (_instance, state) => {
    const observation = JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM observations').one().data) as Observation;
    expect(observation.startAt).toBe(at); expect(observation.status).toBe('pending');
  });
  await waitOnExecutionContext(ctx);
});
