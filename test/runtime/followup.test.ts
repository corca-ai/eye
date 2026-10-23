import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, evictDurableObject, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
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

it('releases the bootstrap safety gap when every issued lease fits the confirmed observation', async () => {
  const siteId=crypto.randomUUID(),ctx=createExecutionContext();
  const eye=createEye({siteId,ctx,service:exports.default,decisions:{secret:'test-decision-secret-longer-than-32-bytes'}});
  await eye.experiments.create({experimentId:'short',arms:['a','b'],settings:{minHoldMs:0,observationWindowMs:10_000,allowedLatenessMs:0}});
  const input={subject:{cid:'lease'},experimentId:'short'};
  const first=assigned((await eye.prepare(input)).decision),target=env.SUBJECTS.getByName(first.routingKey);
  const at=Date.now();
  await target.ingest({siteId,receivedAt:Date.now(),event:{kind:'exposure',eventId:'first',occurredAt:at,subject:input.subject,assignment:first.assignment}});
  await runInDurableObject(target,async(instance,state)=>{
    await state.storage.deleteAlarm();
    const clock=vi.spyOn(Date,'now').mockReturnValue(at+10_001);
    try{
      const next=await instance.prepareReuse(siteId,input.subject,'short');
      expect(next.decision.status).toBe('assigned');
      if(next.decision.status==='assigned')expect(next.decision.assignment.assignmentId).not.toBe(first.assignment.assignmentId);
    }finally{clock.mockRestore();await state.storage.deleteAlarm();}
  });
  await waitOnExecutionContext(ctx);
});

it('keeps the safety pin when an outstanding lease can outlive the first confirmed window', async () => {
  const siteId=crypto.randomUUID(),ctx=createExecutionContext();
  const eye=createEye({siteId,ctx,service:exports.default,decisions:{secret:'test-decision-secret-longer-than-32-bytes'}});
  await eye.experiments.create({experimentId:'queued',arms:['a'],settings:{minHoldMs:0,observationWindowMs:10_000,allowedLatenessMs:0}});
  const input={subject:{cid:'queued'},experimentId:'queued'},first=assigned((await eye.prepare(input)).decision);
  const target=env.SUBJECTS.getByName(first.routingKey),at=first.assignment.assignedAt;
  await runInDurableObject(target,async(instance,state)=>{
    await state.storage.deleteAlarm();let now=at+5000;
    const clock=vi.spyOn(Date,'now').mockImplementation(()=>now);
    try{
      const extended=await instance.prepareReuse(siteId,input.subject,'queued');
      expect(extended.reuseUntil).toBe(at+15_000);
      now=at+6000;
      await instance.ingest({siteId,receivedAt:now,event:{kind:'exposure',eventId:'delayed',occurredAt:at+1,subject:input.subject,assignment:first.assignment}});
      now=at+11_000;
      expect((await instance.prepareReuse(siteId,input.subject,'queued')).decision.status).toBe('unavailable');
      expect(state.storage.kv.get<number>(`lease-pin:${first.assignment.assignmentId}`)).toBeGreaterThanOrEqual(at+25_000);
    }finally{clock.mockRestore();await state.storage.deleteAlarm();}
  });
  await waitOnExecutionContext(ctx);
});

it('protects legacy signed tokens when a delayed exposure moves the window earlier after upgrade', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext();
  const eye = createEye({ siteId, ctx, service: exports.default, decisions: { secret: 'test-decision-secret-longer-than-32-bytes' } });
  const window = 3_600_000;
  await eye.experiments.create({ experimentId: 'legacy', arms: ['a'], settings: { minHoldMs: 0, observationWindowMs: window } });
  const input = { subject: { cid: 'legacy' }, experimentId: 'legacy' };
  const first = assigned((await eye.prepare(input)).decision), target = env.SUBJECTS.getByName(first.routingKey);
  const at = first.assignment.assignedAt;
  await runInDurableObject(target, async (instance, state) => {
    await state.storage.deleteAlarm();
    let now = at + 120_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await instance.ingest({ siteId, receivedAt: now, event: { kind: 'exposure', eventId: 'reported-first', occurredAt: now, subject: input.subject, assignment: first.assignment } });
      // HEAD could retain this bootstrap pin while issuing a later token
      // ending at the confirmed window. There was no lease-until field.
      state.storage.kv.put(`lease-pin:${first.assignment.assignmentId}`, at + window + 300_000);
      state.storage.kv.delete(`lease-until:${first.assignment.assignmentId}`);
      const legacyTokenUntil = at + window + 120_000;
      now = at + window - 60_000;
      await instance.ingest({ siteId, receivedAt: now, event: { kind: 'exposure', eventId: 'earlier-late', occurredAt: at + 60_000, subject: input.subject, assignment: first.assignment } });
      expect(state.storage.kv.get<number>(`lease-pin:${first.assignment.assignmentId}`)).toBeGreaterThanOrEqual(legacyTokenUntil + window);
      const migratedUntil = state.storage.kv.get<number>(`lease-until:${first.assignment.assignmentId}`);
      expect(migratedUntil).toBeGreaterThanOrEqual(legacyTokenUntil);
      now = at + window + 60_001;
      const prepared = await instance.prepareReuse(siteId, input.subject, 'legacy');
      expect(prepared.decision.status).toBe('unavailable');
      expect(state.storage.kv.get(`lease-until:${first.assignment.assignmentId}`)).toBe(migratedUntil);
    } finally { clock.mockRestore(); await state.storage.deleteAlarm(); }
  });
  await waitOnExecutionContext(ctx);
});

it('issues fifteen-minute leases but caps renewal at a confirmed observation end', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext();
  const eye = createEye({ siteId, ctx, service: exports.default, decisions: { secret: 'test-decision-secret-longer-than-32-bytes' } });
  await eye.experiments.create({ experimentId: 'long', arms: ['a'], settings: { minHoldMs: 0, observationWindowMs: 1_200_000 } });
  const subject = { cid: 'long' }, first = assigned((await eye.prepare({ subject, experimentId: 'long' })).decision);
  const at = first.assignment.assignedAt, target = env.SUBJECTS.getByName(first.routingKey);
  await runInDurableObject(target, async (instance, state) => {
    await state.storage.deleteAlarm();
    let now = at + 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      expect((await instance.prepareReuse(siteId, subject, 'long')).reuseUntil).toBe(now + 900_000);
      await instance.ingest({ siteId, receivedAt: now, event: { kind: 'exposure', eventId: 'long-first', occurredAt: at, subject, assignment: first.assignment } });
      now = at + 600_000;
      expect((await instance.prepareReuse(siteId, subject, 'long')).reuseUntil).toBe(at + 1_200_000);
    } finally { clock.mockRestore(); await state.storage.deleteAlarm(); }
  });
  await waitOnExecutionContext(ctx);
});
