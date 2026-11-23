import { env } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { createEye, encodedSize } from '../../src/client.js';
import { EyeWorker } from '../../src/runtime/service.js';
import { SiteControl } from '../../src/runtime/site.js';
import type { EventEnvelope } from '../../src/core/types.js';
import { packIngestion } from '../../src/runtime/queue-batch.js';

it('decodes compressed settings before learning and keeps valid siblings across retries', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext(), service = new EyeWorker(ctx, { ...env, EYE_INSTALLATION_ID: siteId });
  const config = await service.createExperiment({ experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0 } });
  const at = Date.now();
  const envelopes: EventEnvelope[] = Array.from({ length: 99 }, (_, i) => ({ siteId, receivedAt: at,
    event: { kind: 'exposure', eventId: `e-${i}`, occurredAt: at, subject: { cid: `c-${i}` },
      assignment: { assignmentId: `a-${i}`, experimentId: 'exp', armId: 'a', generation: 1, assignedAt: at,
        policyRevision: 1, probability: 1, settings: config.settings },
      sample: { sampleId: `s-${i}`, startAt: at }, attributionWindowMs: 1000 },
  }));
  const packet = packIngestion(envelopes)[0]!;
  expect(packet.settings).toHaveLength(1);
  const first = packet.events[0]!;
  if (first.event.kind !== 'exposure') throw new Error('Expected exposure');
  packet.events.splice(1, 0, { ...first, event: { ...first.event, eventId: 'broken', assignment: { ...first.event.assignment, settings: 99 } } });
  try {
    for (let i = 0; i < 2; i++) {
      const batch = createMessageBatch('eye-events', [{ id: `dictionary-${i}`, timestamp: at, attempts: i + 1, body: packet }]);
      await service.queue(batch);
      expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(0);
    }
    await runInDurableObject(env.SITES.getByName(siteId), (_actor, state) => {
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM learning_samples').one().n).toBe(99);
    });
  } finally { await waitOnExecutionContext(ctx); }
});

it('runs SDK selection, actual exposure, signed goal, closed learning and next policy end to end', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext();
  const envelopes: EventEnvelope[] = [], service = new EyeWorker(ctx, { ...env, EYE_INSTALLATION_ID: siteId });
  vi.spyOn(service, 'ingest').mockImplementation(async items => { envelopes.push(...items.map(item => ({ ...item, siteId: 'installation' }))); });
  const eye = createEye({ ctx, service, decisions: { secret: 'integration-secret-at-least-32-bytes-long' } });
  await eye.goals.create('purchase');
  await eye.experiments.create({ experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0, observationWindowMs: 1000, } });
  const prepared = await eye.prepare({ subject: { cid: 'c' }, experimentId: 'exp' });
  if (prepared.decision.status !== 'assigned') throw new Error('Expected assignment');
  const at = Date.now();
  expect(eye.expose({ subject: { cid: 'c' }, decision: prepared.decision, eventId: 'a-exposure', occurredAt: at }).accepted).toBe(true);
  expect(eye.goal({ subject: { cid: 'c' }, goalId: 'purchase', value: 100, eventId: 'z-goal', occurredAt: at }).accepted).toBe(true);
  await eye.flush(); await eye.state();
  const batch = createMessageBatch('eye-events', envelopes.map(body => ({ id: crypto.randomUUID(), timestamp: Date.now(), attempts: 1, body: { version: 2, events: [{ ...body, siteId }] } })));
  await new EyeWorker(ctx, { ...env, EYE_INSTALLATION_ID: siteId }).queue(batch);
  expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(0);
  const sample = envelopes[0]!.event;
  if (sample.kind !== 'exposure' || !sample.sample) throw new Error('Expected sample');
  const site = env.SITES.getByName(siteId);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at + 62_000);
  try {
    await runInDurableObject(site, async actor => { await actor.alarm(); });
    expect((await eye.experiments.policy('exp')).arms[0]!.meanReward).toBe(100);
  } finally { clock.mockRestore(); }
  await waitOnExecutionContext(ctx);
});
it('collection returns before network completion and rejects nonfinite rewards', async () => {
  const ctx = createExecutionContext(), service = new EyeWorker(ctx, { ...env, EYE_INSTALLATION_ID: env.EYE_INSTALLATION_ID });
  let release!: () => void;
  const delivery = new Promise<void>(resolve => { release = resolve; });
  const ingest = vi.spyOn(service, 'ingest').mockReturnValue(delivery);
  const eye = createEye({ ctx, service });
  expect(eye.goal({ subject: { cid: 'c' }, goalId: 'view', value: 1 }).accepted).toBe(true);
  expect(eye.goal({ subject: { cid: 'c' }, goalId: 'pay', value: NaN }).accepted).toBe(false);
  expect(ingest).not.toHaveBeenCalled();
  const flushing = eye.flush(); await Promise.resolve(); expect(ingest).toHaveBeenCalledTimes(1);
  release(); await flushing; await waitOnExecutionContext(ctx);
});
it('ignores queued page events while updating identity', async () => {
  const ctx = createExecutionContext(), at = Date.now();
  const site = vi.spyOn(env.SITES, 'getByName');
  const input = [
    { siteId: env.EYE_INSTALLATION_ID, receivedAt: at, event: { kind: 'track', eventId: 't', occurredAt: at, subject: { cid: 'c' }, goalId: 'view', value: 1 } },
    { siteId: env.EYE_INSTALLATION_ID, receivedAt: at, event: { kind: 'identify', eventId: 'i', occurredAt: at, subject: { cid: 'c', uid: 'u' } } },
  ];
  const batch = createMessageBatch('eye-events', input.map(body => ({ id: body.event.eventId, timestamp: at, attempts: 1, body: { version: 2, events: [{ ...body, siteId: env.EYE_INSTALLATION_ID }] } })));
  await new EyeWorker(ctx, { ...env, EYE_INSTALLATION_ID: env.EYE_INSTALLATION_ID }).queue(batch);
  expect(site).toHaveBeenCalledTimes(1);
  await runInDurableObject(env.SITES.getByName(env.EYE_INSTALLATION_ID), (_actor, state) => {
    expect(state.storage.sql.exec<{ uid: string }>("SELECT uid FROM learning_identity WHERE cid='c'").one().uid).toBe('u');
  });
  site.mockRestore(); await waitOnExecutionContext(ctx);
});
it('packs ingestion and keeps valid siblings when a Queue event is malformed', async () => {
  const ctx = createExecutionContext(), at = Date.now(), service = new EyeWorker(ctx, { ...env, EYE_INSTALLATION_ID: env.EYE_INSTALLATION_ID });
  const envelopes: EventEnvelope[] = ['one', 'two'].map(eventId => ({ siteId: env.EYE_INSTALLATION_ID, receivedAt: at,
    event: { kind: 'identify', eventId, occurredAt: at, subject: { cid: eventId, uid: 'user' } } }));
  const enqueue = vi.spyOn(env.EVENTS, 'sendBatch').mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
  try {
    await service.ingest(envelopes);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]).toMatchObject([{ body: { version: 2, events: envelopes.map(e => ({ ...e, receivedAt: expect.any(Number) })) }, contentType: 'json' }]);
    await service.ingest([envelopes[0]!, { ...envelopes[1]!, event: { kind: 'goal', eventId: 'large', occurredAt: at,
      subject: { cid: 'c' }, goalId: 'large', value: 1, attributes: { detail: 'x'.repeat(70_000) } } }, envelopes[1]!]);
    expect(enqueue.mock.calls[1]![0]).toHaveLength(1);
    expect(JSON.stringify(enqueue.mock.calls[1]![0])).not.toContain('detail');
    const batch = createMessageBatch('eye-events', [{ id: 'packed', timestamp: at, attempts: 1,
      body: { version: 2, events: [envelopes[0], { invalid: true }, envelopes[1]] } }]);
    await service.queue(batch);
    expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(0);
  } finally { enqueue.mockRestore(); await waitOnExecutionContext(ctx); }
});

it('validates actual UTF-8 sizes before enqueueing any sibling and ignores supplied size metadata', async () => {
  const ctx = createExecutionContext(), service = new EyeWorker(ctx, { ...env, EYE_INSTALLATION_ID: env.EYE_INSTALLATION_ID }), at = Date.now();
  const make = (eventId: string, detail: string) => ({ siteId: 'size-test', receivedAt: at, encodedSize: 1,
    event: { kind: 'goal' as const, eventId, occurredAt: at, subject: { cid: 'c' }, goalId: 'view', value: 1, attributes: { detail } } });
  const enqueue = vi.spyOn(env.EVENTS, 'sendBatch').mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
  try {
    await expect(service.ingest([make('small', ''), make('too-large', '한'.repeat(40_000))])).rejects.toThrow('encoded size');
    await expect(service.ingest(Array.from({ length: 3 }, (_, i) => make(String(i), 'x'.repeat(80_000))))).rejects.toThrow('encoded size');
    expect(enqueue).not.toHaveBeenCalled();
    await service.ingest([make('valid', '한'.repeat(1000))]);
    expect(enqueue).toHaveBeenCalledTimes(1);
  } finally { enqueue.mockRestore(); await waitOnExecutionContext(ctx); }
});
it('retries a packed message if one sibling needs goal configuration, despite retired page events', async () => {
  const ctx = createExecutionContext(), at = Date.now(), service = new EyeWorker(ctx, { ...env, EYE_INSTALLATION_ID: env.EYE_INSTALLATION_ID });
  const site = vi.spyOn(env.SITES, 'getByName').mockImplementation(() => { throw new Error('transient outage'); });
  const body = { version: 2, events: [
    { siteId: env.EYE_INSTALLATION_ID, receivedAt: at, event: { kind: 'track', eventId: 'track', occurredAt: at, subject: { cid: 'c' }, goalId: 'view', value: 1 } },
    { siteId: env.EYE_INSTALLATION_ID, receivedAt: at, event: { kind: 'goal', eventId: 'goal', occurredAt: at, subject: { cid: 'c' }, goalId: 'pay', value: 5 } },
  ] };
  try {
    const batch = createMessageBatch('eye-events', [{ id: 'packed', timestamp: at, attempts: 1, body }]);
    await service.queue(batch);
    expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(1);
  } finally { site.mockRestore(); await waitOnExecutionContext(ctx); }
});

it('collects across microtasks without losing events or waiting for an explicit flush', async () => {
  const ctx = createExecutionContext(), service = new EyeWorker(ctx, { ...env, EYE_INSTALLATION_ID: env.EYE_INSTALLATION_ID }), received: EventEnvelope[] = [];
  const ingest = vi.spyOn(service, 'ingest').mockImplementation(async batch => { received.push(...batch.map(item => ({ ...item, siteId: 'installation' }))); });
  const eye = createEye({ ctx, service });
  for (let i = 0; i < 5; i++) {
    expect(eye.goal({ subject: { cid: 'c' }, goalId: 'view', value: 1, eventId: String(i) }).accepted).toBe(true);
    await Promise.resolve();
  }
  await waitOnExecutionContext(ctx);
  expect(received.map(e => e.event.eventId)).toEqual(['0', '1', '2', '3', '4']);
  expect(ingest).toHaveBeenCalledTimes(1);
});

it('explicit flush bypasses the scheduled send and exposes delivery failures', async () => {
  const ctx = createExecutionContext(), service = new EyeWorker(ctx, { ...env, EYE_INSTALLATION_ID: env.EYE_INSTALLATION_ID }), onError = vi.fn();
  const ingest = vi.spyOn(service, 'ingest').mockRejectedValue(new Error('offline'));
  const eye = createEye({ ctx, service, onError });
  eye.goal({ subject: { cid: 'c' }, goalId: 'view', value: 1 });
  await expect(eye.flush()).rejects.toThrow('offline');
  await waitOnExecutionContext(ctx);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(ingest).toHaveBeenCalledTimes(1);
});

it('keeps acceptance separate for sibling goals inside the same packed message', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext(), service = new EyeWorker(ctx, { ...env, EYE_INSTALLATION_ID: siteId });
  await service.createGoal('active');
  const at = Date.now();
  const events: EventEnvelope[] = ['active', 'unknown'].map(goalId => ({ siteId, receivedAt: at,
    event: { kind: 'goal', eventId: goalId, occurredAt: at, subject: { cid: 'c' }, goalId, value: 100 } }));
  try {
    const batch = createMessageBatch('eye-events', [{ id: 'siblings', timestamp: at, attempts: 1, body: { version: 2, events } }]);
    await service.queue(batch);
    expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(0);
    await runInDurableObject(env.SITES.getByName(siteId), (_actor, state) => {
      expect(state.storage.sql.exec('SELECT event_id, accepted FROM learning_seen ORDER BY event_id').toArray()).toEqual([
        { event_id: 'active', accepted: 1 }, { event_id: 'unknown', accepted: 0 },
      ]);
    });
  } finally { await waitOnExecutionContext(ctx); }
});

it.each(['arm', 'expired window'] as const)('rejects a conflicting %s without retrying or losing valid siblings in its packed message', async conflict => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext(), service = new EyeWorker(ctx, { ...env, EYE_INSTALLATION_ID: siteId });
  const config = await service.createExperiment({ experimentId: 'exp', arms: ['a', 'b'], settings: { minHoldMs: 0, observationWindowMs: 1000, } });
  await service.createGoal('pay');
  const at = Date.now(), events: EventEnvelope[] = [];
  const original: import('../../src/core/types.js').ExposureEvent = { kind: 'exposure', eventId: 'a-valid', occurredAt: at, subject: { cid: 'c' },
    assignment: { assignmentId: 'assignment', experimentId: 'exp', armId: 'a', generation: 1, policyRevision: 1, assignedAt: at, probability: .5, settings: config.settings },
    sample: { sampleId: 'sample', startAt: at }, attributionWindowMs: 1000 };
  const conflictingAssignment = conflict === 'arm' ? { ...original.assignment, armId: 'b' }
    : { ...original.assignment, settings: { ...config.settings, observationWindowMs: 100 } };
  for (const event of [original, { ...original, eventId: 'b-conflict', assignment: conflictingAssignment },
    { kind: 'goal' as const, eventId: 'z-goal', occurredAt: at, subject: original.subject, goalId: 'pay', value: 7 }]) events.push({ siteId, receivedAt: at, event });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at + 200);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const batch = createMessageBatch('eye-events', [{ id: 'packed-conflict', timestamp: at, attempts: 1, body: { version: 2, events } }]);
    await service.queue(batch);
    expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('learning_rejected_exposures'));
    await runInDurableObject(env.SITES.getByName(siteId), (_actor, state) => {
      const sample = state.storage.sql.exec<{ data: string; scale: number; sum: number; correction: number }>('SELECT definition AS data,scale,sum,correction FROM learning_samples').one();
      expect(JSON.parse(sample.data)[0].armId).toBe('a');
      expect(sample.scale * (sample.sum + sample.correction)).toBe(7);
    });
  } finally { clock.mockRestore(); warn.mockRestore(); await waitOnExecutionContext(ctx); }
});

it('rejects malformed Unicode sample IDs while preserving valid packed exposures through closure', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext(), service = new EyeWorker(ctx, { ...env, EYE_INSTALLATION_ID: siteId });
  const config = await service.createExperiment({ experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0 } });
  const at = Date.now();
  const events: EventEnvelope[] = ['\ud800', '\udfff', 'valid-😀'].map((sampleId, i) => ({ siteId, receivedAt: at,
    event: { kind: 'exposure', eventId: String(i), occurredAt: at, subject: { cid: 'c' },
      assignment: { assignmentId: String(i), experimentId: 'exp', armId: 'a', generation: 1, policyRevision: 1, assignedAt: at, probability: 1, settings: config.settings },
      sample: { sampleId, startAt: at }, attributionWindowMs: 1000 } }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const batch = createMessageBatch('eye-events', [{ id: 'unicode', timestamp: at, attempts: 1, body: { version: 2, events } }]);
    await service.queue(batch);
    expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(0);
    await runInDurableObject(env.SITES.getByName(siteId), async (_actor, state) => {
      const { IncrementalLearning } = await import('../../src/runtime/incremental.js');
      const engine = new IncrementalLearning(state.storage.sql);
      state.storage.transactionSync(() => engine.close(at + config.settings.observationWindowMs + 60_000, ({ samples }) => {
        expect(samples.map(sample => sample.sampleId)).toEqual(['valid-😀']);
      }));
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM learning_samples').one().n).toBe(0);
    });
  } finally { warn.mockRestore(); await waitOnExecutionContext(ctx); }
});

it('validates the entire experiment definition before changing site retention bounds', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext(), service = new EyeWorker(ctx, { ...env, EYE_INSTALLATION_ID: siteId }), day = 86_400_000;
  try {
    await expect(service.createExperiment({ experimentId: 'invalid', arms: [], settings: {
      minHoldMs: 0, observationWindowMs: day, attributionWindowMs: day,
    } })).rejects.toThrow('At least one arm');
    const valid = await service.createExperiment({ experimentId: 'valid', arms: ['a'], settings: {
      minHoldMs: 0, observationWindowMs: 40 * day, attributionWindowMs: day,
    } });
    expect(valid.experimentId).toBe('valid');
    expect(await service.listExperiments(siteId)).toEqual(['valid']);
  } finally { await waitOnExecutionContext(ctx); }
});

it('keeps event and batch byte admission consistent with a generated installation UUID', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext(), at = Date.now();
  const service = new EyeWorker(ctx, { ...env, EYE_INSTALLATION_ID: siteId });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  const enqueue = vi.spyOn(env.EVENTS, 'sendBatch').mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
  const eye = createEye({ ctx, service, collectionLimits: { maxBytes: 1_000_000, maxPendingBytes: 1_000_000 } });
  const input = (eventId: string, size: number) => {
    const event = { kind: 'goal' as const, eventId, occurredAt: at, subject: { cid: 'c' }, goalId: 'view', value: 1, attributes: { detail: '' } };
    const overhead = encodedSize({ siteId, receivedAt: at, event }) + 200;
    return { ...event, attributes: { detail: 'x'.repeat(size - overhead) } };
  };
  try {
    expect(eye.goal(input('limit', 100_000)).accepted).toBe(true);
    expect(eye.goal(input('oversized', 100_001)).accepted).toBe(false);
    expect(eye.goal(input('second', 80_000)).accepted).toBe(true);
    expect(eye.goal(input('third', 80_000)).accepted).toBe(true);
    await eye.flush(); await waitOnExecutionContext(ctx);
    expect(enqueue).toHaveBeenCalledTimes(2);
    const delivered = enqueue.mock.calls.flatMap(([batch]) => Array.from(batch).flatMap(message => (message.body as { events: EventEnvelope[] }).events));
    expect(delivered.map(row => row.event.eventId)).toEqual(['limit', 'second', 'third']);
    expect(delivered.every(row => row.siteId === siteId)).toBe(true);
  } finally { enqueue.mockRestore(); clock.mockRestore(); }
});

it('learns from a goal after sign-in without exporting person-level data', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext();
  const runtime = { ...env, EYE_INSTALLATION_ID: siteId };
  const service = new EyeWorker(ctx, runtime), site = env.SITES.getByName(siteId);
  const config = await service.createExperiment({ experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0, observationWindowMs: 1000 } });
  await service.createGoal('purchase');
  const at = Date.now();
  const events: EventEnvelope['event'][] = [
    { kind: 'exposure', eventId: 'exposure', occurredAt: at, subject: { cid: 'browser' }, attributes: { detail: 'unneeded' }, userAttributes: { segment: 'unneeded' },
      assignment: { assignmentId: 'assignment', experimentId: 'exp', armId: 'a', generation: 1, assignedAt: at,
        policyRevision: 1, probability: 1, settings: config.settings },
      sample: { sampleId: 'sample', startAt: at }, attributionWindowMs: 1000 },
    { kind: 'identify', eventId: 'identify', occurredAt: at, subject: { cid: 'browser', uid: 'member' } },
    { kind: 'goal', eventId: 'z-goal', occurredAt: at, subject: { cid: 'browser', uid: 'member' }, goalId: 'purchase', value: 100 },
  ];
  try {
    const batch = createMessageBatch('eye-events', [{ id: 'learning-only', timestamp: at, attempts: 1, body: packIngestion(events.map(event => ({ siteId, event, receivedAt: at })))[0] }]);
    await service.queue(batch);
    expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(0);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at + 62_000);
    try {
      await runInDurableObject(site, async (_actor, state) => {
        const sample = state.storage.sql.exec<{ data: string }>('SELECT data FROM learning_samples').one();
        expect(JSON.parse(sample.data)).toEqual({ occurredAt: at, eventId: 'exposure' });
        // An exposure in progress in the old format closes using the existing definition.
        state.storage.sql.exec('UPDATE learning_samples SET data=?', JSON.stringify(events[0]));
        state.storage.sql.exec('CREATE TABLE learning_outbox (data TEXT)');
        state.storage.sql.exec('INSERT INTO learning_outbox(data) VALUES (?)', JSON.stringify({ records: [{ table_name: 'observations', cid: 'legacy-browser' }] }));
        await new SiteControl(state, runtime).alarm();
        expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'learning_outbox'").toArray()).toEqual([]);
      });
      expect((await service.getPolicy('exp')).arms[0]!.meanReward).toBeCloseTo(100);
    } finally { clock.mockRestore(); }
  } finally { await waitOnExecutionContext(ctx); }
});
