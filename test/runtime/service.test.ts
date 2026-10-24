import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { createEye } from '../../src/client.js';
import { EyeWorker } from '../../src/runtime/service.js';
import { reduceLearningPage } from '../../src/runtime/learning.js';
import { experimentKey } from '../../src/core/validation.js';
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
  const batch = createMessageBatch('eye-events', envelopes.map(body => ({ id: crypto.randomUUID(), timestamp: Date.now(), attempts: 1, body })));
  await new EyeWorker(ctx, env).queue(batch);
  expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(0);
  expect(rows.filter(r => r.table_name === 'events')).toHaveLength(2);
  const sample = envelopes[0]!.event;
  if (sample.kind !== 'exposure' || !sample.sample) throw new Error('Expected sample');
  const page = reduceLearningPage(siteId, 'job/one', at, at + 2000, [sample.sample.sampleId], envelopes.map(e => e.event), null, at + 2000);
  expect(page.cohort.samples[0]!.reward).toBe(100);
  const actor = env.EXPERIMENTS.getByName(experimentKey(siteId, 'exp'));
  expect(await actor.applyCohort(page.cohort)).toBe(true);
  expect(await actor.applyCohort(page.cohort)).toBe(false);
  expect((await eye.experiments.policy('exp')).arms[0]!.meanReward).toBe(100);
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
it('raw-only track and identity ingestion performs no site/user lookup', async () => {
  const ctx = createExecutionContext(), at = Date.now();
  const records: AnalyticsRecord[] = [];
  const send = vi.spyOn(env.ANALYTICS, 'send').mockImplementation(async rows => { records.push(...rows as AnalyticsRecord[]); });
  const site = vi.spyOn(env.SITES, 'getByName');
  const input: EventEnvelope[] = [
    { siteId: 'site', receivedAt: at, event: { kind: 'track', eventId: 't', occurredAt: at, subject: { cid: 'c' }, name: 'view' } },
    { siteId: 'site', receivedAt: at, event: { kind: 'identify', eventId: 'i', occurredAt: at, subject: { cid: 'c', uid: 'u' } } },
  ];
  const batch = createMessageBatch('eye-events', input.map(body => ({ id: body.event.eventId, timestamp: at, attempts: 1, body })));
  await new EyeWorker(ctx, env).queue(batch);
  expect(site).not.toHaveBeenCalled(); expect(records.filter(r => r.table_name === 'events')).toHaveLength(2);
  expect(records.some(r => r.table_name === 'identity_links')).toBe(true);
  site.mockRestore(); send.mockRestore(); await waitOnExecutionContext(ctx);
});
