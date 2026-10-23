import { env } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { EyeWorker } from '../../src/runtime/service.js';
import { experimentKey, subjectKey } from '../../src/core/validation.js';
import { observationShard, shardKey } from '../../src/runtime/shard.js';
import type { EventEnvelope, Observation } from '../../src/core/types.js';

// A local workerd workload, not a remote latency or billing benchmark.
it('measures the storage work of 100 queued track events for a returning browser', async () => {
  const siteId = crypto.randomUUID(), subject = { cid: 'returning' }, now = Date.now();
  const target = env.SUBJECTS.getByName(subjectKey(siteId, subject));
  const counts = { sqlRowsWritten: 0, kvPuts: 0, kvDeletes: 0, setAlarm: 0 };
  const envelope = (i: number): EventEnvelope => ({ siteId, receivedAt: now, event: {
    kind: 'track', eventId: `page:${i}`, occurredAt: now, subject, name: 'page_view', attributes: { path: '/shop' },
  } });
  // Warm the same storage/schema and keep setup out of the recorded counters.
  await target.ingest(envelope(-1)); await target.flush();
  await runInDurableObject(target, (_instance, state) => {
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    vi.spyOn(state.storage.sql, 'exec').mockImplementation((...args: Parameters<SqlStorage['exec']>) => {
      const cursor = exec(...args); counts.sqlRowsWritten += cursor.rowsWritten; return cursor;
    });
    const put = state.storage.kv.put.bind(state.storage.kv);
    vi.spyOn(state.storage.kv, 'put').mockImplementation((key, value) => { counts.kvPuts++; put(key, value); });
    const del = state.storage.kv.delete.bind(state.storage.kv);
    vi.spyOn(state.storage.kv, 'delete').mockImplementation(key => { counts.kvDeletes++; return del(key); });
    const alarm = state.storage.setAlarm.bind(state.storage);
    vi.spyOn(state.storage, 'setAlarm').mockImplementation((...args) => { counts.setAlarm++; return alarm(...args); });
  });
  const ctx = createExecutionContext(), worker = new EyeWorker(ctx, env);
  const batch = createMessageBatch('eye-events', Array.from({ length: 100 }, (_, i) => ({
    id: `message:${i}`, timestamp: now, attempts: 1, body: envelope(i),
  })));
  await worker.queue(batch);
  // Include eventual outbox delivery in both versions; do not wait for a timer.
  await target.flush();
  await waitOnExecutionContext(ctx);
  expect((await getQueueResult(batch, ctx)).retryMessages).toEqual([]);
  await runInDurableObject(target, () => { vi.restoreAllMocks(); });
  expect(counts).toEqual({ sqlRowsWritten: 0, kvPuts: 0, kvDeletes: 0, setAlarm: 0 });
});

it('avoids rewriting immutable shard metadata and learned moments for pending-only corrections', async () => {
  const siteId = crypto.randomUUID(), subject = { cid: 'pending' }, experimentId = 'layout';
  const experiment = env.EXPERIMENTS.getByName(experimentKey(siteId, experimentId));
  await experiment.create({ experimentId, arms: ['a', 'b'], settings: { minHoldMs: 100_000, observationWindowMs: 10_000, allowedLatenessMs: 0 } });
  const target = env.SUBJECTS.getByName(subjectKey(siteId, subject));
  const decision = await target.decide(siteId, subject, experimentId);
  if (decision.status !== 'assigned') throw new Error('Missing assignment');
  await target.ingest({ siteId, receivedAt: Date.now(), event: { kind: 'exposure', eventId: 'first', subject, occurredAt: decision.assignment.assignedAt, assignment: decision.assignment } });
  await target.flush();
  const observation = await runInDurableObject(target, (_instance, state) => JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM observations').one().data) as Observation);
  const shard = env.OBSERVATIONS.getByName(shardKey(siteId, experimentId, observationShard(observation.subjectKey)));
  const writes = await runInDurableObject(shard, async (instance, state) => {
    const counts = { identity: 0, settings: 0, moments: 0 };
    const put = state.storage.kv.put.bind(state.storage.kv);
    const spy = vi.spyOn(state.storage.kv, 'put').mockImplementation((key, value) => {
      if (key === 'identity') counts.identity++;
      if (key.startsWith('settings:')) counts.settings++;
      if (key.startsWith('moment:')) counts.moments++;
      put(key, value);
    });
    try {
      for (let i = 1; i <= 100; i++) await instance.apply(siteId, { ...observation, revision: observation.revision + i, reward: i });
      await instance.publish();
      return counts;
    } finally { spy.mockRestore(); }
  });
  const policy = await experiment.getPolicy();
  expect(policy.arms.reduce((sum, a) => sum + a.pending, 0)).toBe(1);
  expect(policy.arms.reduce((sum, a) => sum + a.weight, 0)).toBe(0);
  expect(writes).toEqual({ identity: 0, settings: 0, moments: 0 });
});
