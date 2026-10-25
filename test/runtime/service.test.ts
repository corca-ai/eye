import { env } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { createEye } from '../../src/client.js';
import { EyeWorker } from '../../src/runtime/service.js';
import type { EventEnvelope } from '../../src/core/types.js';
import type { AnalyticsRecord } from '../../src/analytics/records.js';

it('runs SDK selection, actual exposure, signed goal, raw export, closed learning and next policy end to end', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext();
  const envelopes: EventEnvelope[] = [], service = new EyeWorker(ctx, env);
  vi.spyOn(service, 'ingest').mockImplementation(async items => { envelopes.push(...items); });
  const eye = createEye({ siteId, ctx, service, decisions: { secret: 'integration-secret-at-least-32-bytes-long' } });
  await eye.goals.create('purchase');
  await eye.experiments.create({ experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0, observationWindowMs: 1000, allowedLatenessMs: 0 } });
  const prepared = await eye.prepare({ subject: { cid: 'c' }, experimentId: 'exp' });
  if (prepared.decision.status !== 'assigned') throw new Error('Expected assignment');
  const at = Date.now();
  expect(eye.expose({ subject: { cid: 'c' }, decision: prepared.decision, eventId: 'a-exposure', occurredAt: at }).accepted).toBe(true);
  expect(eye.goal({ subject: { cid: 'c' }, goalId: 'purchase', value: 100, eventId: 'z-goal', occurredAt: at }).accepted).toBe(true);
  await eye.flush(); await eye.state();
  const rows: AnalyticsRecord[] = [];
  const send = vi.spyOn(env.ANALYTICS, 'send').mockImplementation(async records => { rows.push(...records as AnalyticsRecord[]); });
  const batch = createMessageBatch('eye-events', envelopes.map(body => ({ id: crypto.randomUUID(), timestamp: Date.now(), attempts: 1, body: { version: 2, events: [body] } })));
  await new EyeWorker(ctx, env).queue(batch);
  expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(0);
  expect(rows.filter(r => r.table_name === 'events')).toHaveLength(2);
  const sample = envelopes[0]!.event;
  if (sample.kind !== 'exposure' || !sample.sample) throw new Error('Expected sample');
  const site = env.SITES.getByName(siteId);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at + 2000);
  try {
    await runInDurableObject(site, async actor => { await actor.alarm(); });
    expect((await eye.experiments.policy('exp')).arms[0]!.meanReward).toBe(100);
  } finally { clock.mockRestore(); }
  send.mockRestore(); await waitOnExecutionContext(ctx);
});
it('collection returns before network completion and rejects nonfinite rewards', async () => {
  const ctx = createExecutionContext(), service = new EyeWorker(ctx, env);
  let release!: () => void;
  const delivery = new Promise<void>(resolve => { release = resolve; });
  const ingest = vi.spyOn(service, 'ingest').mockReturnValue(delivery);
  const eye = createEye({ siteId: 'site', ctx, service });
  expect(eye.track({ subject: { cid: 'c' }, name: 'view' }).accepted).toBe(true);
  expect(eye.goal({ subject: { cid: 'c' }, goalId: 'pay', value: NaN }).accepted).toBe(false);
  expect(ingest).not.toHaveBeenCalled();
  const flushing = eye.flush(); await Promise.resolve(); expect(ingest).toHaveBeenCalledTimes(1);
  release(); await flushing; await waitOnExecutionContext(ctx);
});
it('track bypasses learning while identity events update the site learner', async () => {
  const ctx = createExecutionContext(), at = Date.now();
  const records: AnalyticsRecord[] = [];
  const send = vi.spyOn(env.ANALYTICS, 'send').mockImplementation(async rows => { records.push(...rows as AnalyticsRecord[]); });
  const site = vi.spyOn(env.SITES, 'getByName');
  const input: EventEnvelope[] = [
    { siteId: 'site', receivedAt: at, event: { kind: 'track', eventId: 't', occurredAt: at, subject: { cid: 'c' }, name: 'view' } },
    { siteId: 'site', receivedAt: at, event: { kind: 'identify', eventId: 'i', occurredAt: at, subject: { cid: 'c', uid: 'u' } } },
  ];
  const batch = createMessageBatch('eye-events', input.map(body => ({ id: body.event.eventId, timestamp: at, attempts: 1, body: { version: 2, events: [body] } })));
  await new EyeWorker(ctx, env).queue(batch);
  expect(site).toHaveBeenCalledTimes(1); expect(records.filter(r => r.table_name === 'events')).toHaveLength(2);
  expect(records.some(r => r.table_name === 'identity_links')).toBe(true);
  site.mockRestore(); send.mockRestore(); await waitOnExecutionContext(ctx);
});
it('packs ingestion and keeps valid siblings when a Queue event is malformed', async () => {
  const ctx = createExecutionContext(), at = Date.now(), service = new EyeWorker(ctx, env);
  const envelopes: EventEnvelope[] = ['one', 'two'].map(eventId => ({ siteId: 'batch-site', receivedAt: at,
    event: { kind: 'track', eventId, occurredAt: at, subject: { cid: 'c' }, name: 'view' } }));
  const enqueue = vi.spyOn(env.EVENTS, 'sendBatch').mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
  const rows: AnalyticsRecord[] = [];
  const send = vi.spyOn(env.ANALYTICS, 'send').mockImplementation(async records => { rows.push(...records as AnalyticsRecord[]); });
  try {
    await service.ingest(envelopes);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]).toEqual([{ body: { version: 2, events: envelopes }, contentType: 'json' }]);
    await service.ingest([envelopes[0]!, { ...envelopes[1]!, event: { kind: 'track', eventId: 'large', occurredAt: at,
      subject: { cid: 'c' }, name: 'large', attributes: { detail: 'x'.repeat(70_000) } } }, envelopes[1]!]);
    expect(enqueue.mock.calls[1]![0]).toHaveLength(3);
    const batch = createMessageBatch('eye-events', [{ id: 'packed', timestamp: at, attempts: 1,
      body: { version: 2, events: [envelopes[0], { invalid: true }, envelopes[1]] } }]);
    await service.queue(batch);
    expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(0);
    expect(rows.filter(row => row.table_name === 'events').map(row => row.record_id)).toEqual(['one', 'two']);
  } finally { enqueue.mockRestore(); send.mockRestore(); await waitOnExecutionContext(ctx); }
});

it('validates actual UTF-8 sizes before enqueueing any sibling and ignores supplied size metadata', async () => {
  const ctx = createExecutionContext(), service = new EyeWorker(ctx, env), at = Date.now();
  const make = (eventId: string, detail: string) => ({ siteId: 'size-test', receivedAt: at, encodedSize: 1,
    event: { kind: 'track' as const, eventId, occurredAt: at, subject: { cid: 'c' }, name: 'view', attributes: { detail } } });
  const enqueue = vi.spyOn(env.EVENTS, 'sendBatch').mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
  try {
    await expect(service.ingest([make('small', ''), make('too-large', '한'.repeat(40_000))])).rejects.toThrow('encoded size');
    await expect(service.ingest(Array.from({ length: 3 }, (_, i) => make(String(i), 'x'.repeat(80_000))))).rejects.toThrow('encoded size');
    expect(enqueue).not.toHaveBeenCalled();
    await service.ingest([make('valid', '한'.repeat(1000))]);
    expect(enqueue).toHaveBeenCalledTimes(1);
  } finally { enqueue.mockRestore(); await waitOnExecutionContext(ctx); }
});
it('retries a packed message if one sibling needs goal configuration, even after exporting track siblings', async () => {
  const ctx = createExecutionContext(), at = Date.now(), service = new EyeWorker(ctx, env);
  const site = vi.spyOn(env.SITES, 'getByName').mockImplementation(() => { throw new Error('transient outage'); });
  const send = vi.spyOn(env.ANALYTICS, 'send').mockResolvedValue(undefined);
  const body = { version: 2, events: [
    { siteId: 'site', receivedAt: at, event: { kind: 'track', eventId: 'track', occurredAt: at, subject: { cid: 'c' }, name: 'view' } },
    { siteId: 'site', receivedAt: at, event: { kind: 'goal', eventId: 'goal', occurredAt: at, subject: { cid: 'c' }, goalId: 'pay', value: 5 } },
  ] };
  try {
    const batch = createMessageBatch('eye-events', [{ id: 'packed', timestamp: at, attempts: 1, body }]);
    await service.queue(batch);
    expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  } finally { site.mockRestore(); send.mockRestore(); await waitOnExecutionContext(ctx); }
});

it.each([false, true])('exports admitted high-cardinality attributes in bounded chunks, retry=%s', async failOnce => {
  const ctx = createExecutionContext(), service = new EyeWorker(ctx, env);
  const envelopes: EventEnvelope[] = [];
  const ingest = vi.spyOn(service, 'ingest').mockImplementation(async items => { envelopes.push(...items); });
  // Exercise the explicit high-cardinality override; ordinary requests use a smaller key budget.
  const eye = createEye({ siteId: crypto.randomUUID(), ctx, service, collectionLimits: { maxAttributeKeys: 10_000 } });
  const attributes = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [String(i), 0]));
  for (const [eventId, attrs] of [['before', {}], ['large', attributes], ['after', {}]] as const) {
    expect(eye.track({ eventId, subject: { cid: 'c' }, name: 'view', attributes: attrs }).accepted).toBe(true);
  }
  await eye.flush(); ingest.mockRestore();
  const sent: AnalyticsRecord[][] = [], previouslyDelivered: AnalyticsRecord[] = [];
  let attempts = 0;
  const send = vi.spyOn(env.ANALYTICS, 'send').mockImplementation(async records => {
    expect(new TextEncoder().encode(JSON.stringify(records)).byteLength).toBeLessThanOrEqual(4_500_000);
    if (++attempts === 2 && failOnce) throw new Error('temporary chunk failure');
    sent.push(records as AnalyticsRecord[]);
  });
  const batch = () => createMessageBatch('eye-events', envelopes.map((body, i) => ({ id: `message-${i}`, timestamp: Date.now(), attempts: 1, body: { version: 2, events: [body] } })));
  try {
    if (failOnce) {
      const first = batch();
      await expect(service.queue(first)).rejects.toThrow('temporary chunk failure');
      expect((await getQueueResult(first, ctx)).retryMessages).toHaveLength(envelopes.length);
      previouslyDelivered.push(...sent.flat());
      sent.length = 0;
    }
    const complete = batch(); await service.queue(complete);
    expect((await getQueueResult(complete, ctx)).retryMessages).toHaveLength(0);
    expect(attempts).toBeGreaterThan(1);
    const rows = sent.flat();
    expect(rows.filter(r => r.table_name === 'events').map(r => r.record_id)).toEqual(['before', 'large', 'after']);
    expect(new Set([...previouslyDelivered, ...rows].filter(r => r.table_name === 'attribute_keys').map(r => JSON.parse(r.payload_json).key)).size).toBe(10000);
  } finally { send.mockRestore(); await waitOnExecutionContext(ctx); }
});

it('collects across microtasks without losing events or waiting for an explicit flush', async () => {
  const ctx = createExecutionContext(), service = new EyeWorker(ctx, env), received: EventEnvelope[] = [];
  const ingest = vi.spyOn(service, 'ingest').mockImplementation(async batch => { received.push(...batch); });
  const eye = createEye({ siteId: 'batch-microtasks', ctx, service });
  for (let i = 0; i < 5; i++) {
    expect(eye.track({ subject: { cid: 'c' }, name: 'view', eventId: String(i) }).accepted).toBe(true);
    await Promise.resolve();
  }
  await waitOnExecutionContext(ctx);
  expect(received.map(e => e.event.eventId)).toEqual(['0', '1', '2', '3', '4']);
  expect(ingest).toHaveBeenCalledTimes(1);
});

it('explicit flush bypasses the scheduled send and exposes delivery failures', async () => {
  const ctx = createExecutionContext(), service = new EyeWorker(ctx, env), onError = vi.fn();
  const ingest = vi.spyOn(service, 'ingest').mockRejectedValue(new Error('offline'));
  const eye = createEye({ siteId: 'batch-failure', ctx, service, onError });
  eye.track({ subject: { cid: 'c' }, name: 'view' });
  await expect(eye.flush()).rejects.toThrow('offline');
  await waitOnExecutionContext(ctx);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(ingest).toHaveBeenCalledTimes(1);
});

it('keeps acceptance separate for sibling goals inside the same packed message', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext(), service = new EyeWorker(ctx, env);
  await service.createGoal(siteId, 'active');
  const at = Date.now(), rows: AnalyticsRecord[] = [];
  const send = vi.spyOn(env.ANALYTICS, 'send').mockImplementation(async records => { rows.push(...records as AnalyticsRecord[]); });
  const events: EventEnvelope[] = ['active', 'unknown'].map(goalId => ({ siteId, receivedAt: at,
    event: { kind: 'goal', eventId: goalId, occurredAt: at, subject: { cid: 'c' }, goalId, value: 100 } }));
  try {
    const batch = createMessageBatch('eye-events', [{ id: 'siblings', timestamp: at, attempts: 1, body: { version: 2, events } }]);
    await service.queue(batch);
    expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(0);
    expect(rows.find(row => row.record_id === 'active')!.status).toBe('accepted');
    expect(rows.find(row => row.record_id === 'unknown')!.status).toBe('inactive');
  } finally { send.mockRestore(); await waitOnExecutionContext(ctx); }
});

it.each(['arm', 'expired window'] as const)('rejects a conflicting %s without retrying or losing valid siblings in its packed message', async conflict => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext(), service = new EyeWorker(ctx, env);
  const config = await service.createExperiment(siteId, { experimentId: 'exp', arms: ['a', 'b'], settings: { minHoldMs: 0, observationWindowMs: 1000, allowedLatenessMs: 0 } });
  await service.createGoal(siteId, 'pay');
  const at = Date.now(), events: EventEnvelope[] = [];
  const original: import('../../src/core/types.js').ExposureEvent = { kind: 'exposure', eventId: 'a-valid', occurredAt: at, subject: { cid: 'c' },
    assignment: { assignmentId: 'assignment', experimentId: 'exp', armId: 'a', generation: 1, policyRevision: 1, assignedAt: at, probability: .5, settings: config.settings },
    sample: { sampleId: 'sample', startAt: at }, attributionWindowMs: 1000 };
  const conflictingAssignment = conflict === 'arm' ? { ...original.assignment, armId: 'b' }
    : { ...original.assignment, settings: { ...config.settings, observationWindowMs: 100 } };
  for (const event of [original, { ...original, eventId: 'b-conflict', assignment: conflictingAssignment },
    { kind: 'goal' as const, eventId: 'z-goal', occurredAt: at, subject: original.subject, goalId: 'pay', value: 7 }]) events.push({ siteId, receivedAt: at, event });
  const rows: AnalyticsRecord[] = [];
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at + 200);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const send = vi.spyOn(env.ANALYTICS, 'send').mockImplementation(async batch => { rows.push(...batch as AnalyticsRecord[]); });
  try {
    const batch = createMessageBatch('eye-events', [{ id: 'packed-conflict', timestamp: at, attempts: 1, body: { version: 2, events } }]);
    await service.queue(batch);
    expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(0);
    expect(rows.filter(r => r.table_name === 'events').map(r => r.record_id)).toEqual(['a-valid', 'z-goal']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('learning_rejected_exposures'));
    await runInDurableObject(env.SITES.getByName(siteId), (_actor, state) => {
      const sample = state.storage.sql.exec<{ data: string; scale: number; sum: number; correction: number }>('SELECT data,scale,sum,correction FROM learning_samples').one();
      expect(JSON.parse(sample.data).assignment.armId).toBe('a');
      expect(sample.scale * (sample.sum + sample.correction)).toBe(7);
    });
  } finally { clock.mockRestore(); warn.mockRestore(); send.mockRestore(); await waitOnExecutionContext(ctx); }
});

it('rejects malformed Unicode sample IDs while preserving valid packed exposures through closure', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext(), service = new EyeWorker(ctx, env);
  const config = await service.createExperiment(siteId, { experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 0 } });
  const at = Date.now();
  const events: EventEnvelope[] = ['\ud800', '\udfff', 'valid-😀'].map((sampleId, i) => ({ siteId, receivedAt: at,
    event: { kind: 'exposure', eventId: String(i), occurredAt: at, subject: { cid: 'c' },
      assignment: { assignmentId: String(i), experimentId: 'exp', armId: 'a', generation: 1, policyRevision: 1, assignedAt: at, probability: 1, settings: config.settings },
      sample: { sampleId, startAt: at }, attributionWindowMs: 1000 } }));
  const rows: AnalyticsRecord[] = [];
  const send = vi.spyOn(env.ANALYTICS, 'send').mockImplementation(async batch => { rows.push(...batch as AnalyticsRecord[]); });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const batch = createMessageBatch('eye-events', [{ id: 'unicode', timestamp: at, attempts: 1, body: { version: 2, events } }]);
    await service.queue(batch);
    expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(0);
    expect(rows.filter(r => r.table_name === 'events').map(r => r.record_id)).toEqual(['2']);
    await runInDurableObject(env.SITES.getByName(siteId), async (_actor, state) => {
      const { IncrementalLearning } = await import('../../src/runtime/incremental.js');
      const engine = new IncrementalLearning(state.storage.sql);
      state.storage.transactionSync(() => engine.close(siteId, at + config.settings.observationWindowMs + config.settings.allowedLatenessMs, () => {}));
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM learning_samples').one().n).toBe(0);
      expect(engine.outputs().flatMap(output => output.output.records).map(row => row.record_id)).toEqual(['valid-😀']);
    });
  } finally { send.mockRestore(); warn.mockRestore(); await waitOnExecutionContext(ctx); }
});

it('validates the entire experiment definition before changing site retention bounds', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext(), service = new EyeWorker(ctx, env), day = 86_400_000;
  try {
    await expect(service.createExperiment(siteId, { experimentId: 'invalid', arms: [], settings: {
      minHoldMs: 0, observationWindowMs: day, allowedLatenessMs: 40 * day, attributionWindowMs: day,
    } })).rejects.toThrow('At least one arm');
    const valid = await service.createExperiment(siteId, { experimentId: 'valid', arms: ['a'], settings: {
      minHoldMs: 0, observationWindowMs: 40 * day, allowedLatenessMs: 0, attributionWindowMs: day,
    } });
    expect(valid.experimentId).toBe('valid');
    expect(await service.listExperiments(siteId)).toEqual(['valid']);
  } finally { await waitOnExecutionContext(ctx); }
});
