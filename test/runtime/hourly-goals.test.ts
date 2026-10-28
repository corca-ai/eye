import { env, exports } from 'cloudflare:workers';
import { runInDurableObject, createExecutionContext, waitOnExecutionContext, createMessageBatch, getQueueResult, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { DecisionCache } from '../../src/decisions.js';
import { ExperimentState } from '../../src/runtime/experiment-state.js';
import { HourlyGoals } from '../../src/runtime/hourly-goals.js';
import { IncrementalLearning } from '../../src/runtime/incremental.js';
import { EyeWorker } from '../../src/runtime/service.js';
import { createEye } from '../../src/client.js';
import type { GoalEvent } from '../../src/core/types.js';

const H = 3_600_000, start = 100 * H;
const goal = (eventId: string, at: number, value = 1): GoalEvent => ({ kind: 'goal', goalId: 'pay', eventId, occurredAt: at, value, subject: { cid: 'c' } });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it('uses receipt hours, includes signed goals, seals exactly ten minutes after hour end, and never reopens', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, state) => {
    const s = new HourlyGoals(state.storage.sql, start);
    s.add(goal('a', start - 1, 3), start, start);
    s.add(goal('b', start + 1, -1), start + 1, start + 1);
    const query = { from: start, to: start + H };
    expect(() => s.query(query, start + H + 599_999)).toThrow('finalized');
    const before = s.query(query, start + H + 600_000);
    expect(before.rows).toEqual([{ goalId: 'pay', bucketStart: start, events: 2, totalValue: 2 }]);
    s.add(goal('too-late', start + 2, 100), start + 2, start + H + 600_000);
    expect(s.query(query, start + H + 600_001).rows).toEqual(before.rows);
    expect(new HourlyGoals(state.storage.sql, start + 2 * H).query(query, start + 2 * H).rows).toEqual(before.rows);
    expect(() => s.query({ ...query, from: start - H }, start + 2 * H)).toThrow('covered');
  });
});

it('counts accepted goals once with durable retries and rolls back aggregate writes with dedup', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, state) => {
    const engine = new IncrementalLearning(state.storage.sql), g = goal('one', start - 1, 7);
    const accept = () => engine.accept([g], start + 3, () => true, [start]);
    expect(() => state.storage.transactionSync(() => { accept(); throw Error('abort'); })).toThrow('abort');
    state.storage.transactionSync(accept); state.storage.transactionSync(accept);
    state.storage.transactionSync(() => engine.accept([goal('inactive', start)], start, () => false, [start]));
    expect(engine.hourlyGoals.query({ from: start, to: start + H }, start + 2 * H).rows).toEqual([
      { goalId: 'pay', bucketStart: start, events: 1, totalValue: 7 },
    ]);
  });
  clock.mockRestore();
});

it('enforces 15-second external admission using server time but preserves accepted Queue retries', async () => {
  const ctx = createExecutionContext(), service = new EyeWorker(ctx, env);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  const enqueue = vi.spyOn(env.EVENTS, 'sendBatch').mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
  const send = vi.spyOn(env.ANALYTICS, 'send').mockResolvedValue(undefined);
  await exports.default.createGoal('pay');
  const eye = createEye({ ctx, service });
  expect(eye.goal({ goalId: 'pay', value: 1, subject: { cid: 'c' }, occurredAt: start - 15_001 }).accepted).toBe(false);
  await service.ingest([{ receivedAt: 0, event: goal('boundary', start - 15_000) }]);
  await expect(service.ingest([{ receivedAt: start, event: goal('expired', start - 15_001) }])).rejects.toThrow('15 seconds');
  const packets = Array.from(enqueue.mock.calls[0]![0]);
  expect(packets[0]!.body).toMatchObject({ events: [{ receivedAt: start }] });
  clock.mockReturnValue(start + 120_000);
  const batch = createMessageBatch('eye-events', [{ id: 'retry', timestamp: start, attempts: 2, body: packets[0]!.body }]);
  await service.queue(batch);
  expect((await getQueueResult(batch, ctx)).retryMessages).toEqual([]);
  expect(send).toHaveBeenCalled();
  await waitOnExecutionContext(ctx);
});

it('expires receipt-hour rows on idle installations even after occurrence-time dedup expires', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, state) => {
    const engine = new IncrementalLearning(state.storage.sql);
    state.storage.transactionSync(() => engine.accept([goal('boundary', start - 10_000)], start, () => true, [start]));
    const expiry = start + 60 * 24 * H;
    state.storage.transactionSync(() => engine.prune(expiry));
    expect(engine.nextWake(expiry)).not.toBeNull();
    state.storage.transactionSync(() => engine.prune(expiry + 1));
    expect(state.storage.sql.exec('SELECT bucket FROM hourly_goals').toArray()).toEqual([]);
    expect(engine.nextWake(expiry + 1)).toBeNull();
  });
});

it('migrates old experiment definitions and pending samples to the fixed grace without accepting a new setting', async () => {
  const { settings } = await import('../../src/core/validation.js');
  const { parseEvent } = await import('../../src/core/events.js');
  vi.spyOn(Date, 'now').mockReturnValue(start);
  expect(() => settings({ minHoldMs: 0, allowedLatenessMs: 123 })).toThrow('Unknown setting');
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (actor, state) => {
    const config = actor.createExperiment('migration', { experimentId: 'old', arms: ['a'], settings: { minHoldMs: 0, observationWindowMs: 1000 } });
    const legacy = { ...config.settings, allowedLatenessMs: H };
    const experiment = new ExperimentState(state.storage.sql, state.storage.kv, 'old');
    const published = { ...experiment.publish('migration', H), sequence: 42, settings: legacy };
    const cache = new DecisionCache(); cache.put('old', published);
    state.storage.kv.put(JSON.stringify(['experiment', 'old', 'publishedPolicy']), published);
    state.storage.kv.put(JSON.stringify(['experiment', 'old', 'config']), { ...config, settings: legacy });
    state.storage.kv.put(JSON.stringify(['experiment', 'old', 'definition']), { experimentId: 'old', arms: ['a'], settings: legacy });
    expect(actor.getExperiment('migration', 'old').settings).not.toHaveProperty('allowedLatenessMs');
    const refreshed = experiment.publish('migration', H);
    expect(refreshed.sequence).toBe(43);
    cache.put('old', refreshed);
    expect(cache.read('old')?.sequence).toBe(43);
    expect(refreshed.settings).not.toHaveProperty('allowedLatenessMs');
    expect(actor.createExperiment('migration', { experimentId: 'old', arms: ['a'], settings: { minHoldMs: 0, observationWindowMs: 1000 } }).generation).toBe(1);
    expect(actor.updateExperiment('migration', 'old', { minHoldMs: 1 }).generation).toBe(2);
    const exposure = { kind: 'exposure', eventId: 'shown', occurredAt: start, subject: { cid: 'c' },
      assignment: { assignmentId: 'assigned', experimentId: 'old', armId: 'a', generation: 1, policyRevision: 1, assignedAt: start,
        probability: 1, settings: legacy }, sample: { sampleId: 'sample', startAt: start }, attributionWindowMs: H };
    const parsed = parseEvent(exposure);
    expect(parsed.kind === 'exposure' && parsed.assignment.settings).not.toHaveProperty('allowedLatenessMs');
    const engine = new IncrementalLearning(state.storage.sql);
    state.storage.transactionSync(() => engine.accept([parsed], start));
    state.storage.sql.exec(`UPDATE learning_samples SET close_at=?,data=?,definition=?`, start + H + 1000,
      JSON.stringify(exposure), JSON.stringify([exposure.assignment, start, H]));
    state.storage.sql.exec('DELETE FROM learning_runtime_version');
    const migrated = state.storage.transactionSync(() => new IncrementalLearning(state.storage.sql));
    expect(state.storage.sql.exec<{ close_at: number }>('SELECT close_at FROM learning_samples').one().close_at).toBe(start + 61_000);
    expect(state.storage.transactionSync(() => migrated.accept([goal('after-cutoff', start + 500)], start + 61_000)).diagnostics.closedGoals).toBe(1);
    expect(state.storage.transactionSync(() => migrated.close('migration', start + 61_000, () => {}))).toBe(1);
  });
});
