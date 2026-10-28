import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { IncrementalLearning } from '../../src/runtime/incremental.js';
import { settings, RETENTION_MS } from '../../src/core/validation.js';
import type { ExposureEvent, GoalEvent } from '../../src/core/types.js';
import { EyeWorker } from '../../src/runtime/service.js';
import { createEye } from '../../src/client.js';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';

const H = 3_600_000, start = 10 * H;
const config = settings({ minHoldMs: 0, observationWindowMs: 1000, attributionHalfLifeMs: H });
const goal = (eventId: string, at: number, value: number): GoalEvent => ({ kind: 'goal', eventId, occurredAt: at, subject: { cid: 'c' }, goalId: 'pay', value });
const exposure = (sampleId: string, at: number, armId = 'a', generation = 1): ExposureEvent => ({ kind: 'exposure', eventId: sampleId, occurredAt: at,
  subject: { cid: sampleId }, assignment: { assignmentId: sampleId, experimentId: 'e', armId, generation, policyRevision: 1,
    assignedAt: at, probability: .5, settings: config }, sample: { sampleId, startAt: at }, attributionWindowMs: H });

it('summarizes accepted goals once, preserves rejected decisions and never counts an outbox retry', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, ctx) => {
    const engine = new IncrementalLearning(ctx.storage.sql), summaries = engine.summaries;
    const atomic = <T>(fn: () => T) => ctx.storage.transactionSync(fn);
    expect(summaries.status(start).state).toBe('disabled');
    atomic(() => summaries.configure({ goalIds: ['pay'], experimentIds: ['e'] }, start));
    const events = [goal('a', start + 1, 10), goal('b', start + 2, -2), goal('c', start + 3, 0)];
    atomic(() => engine.accept(events, start + 4));
    atomic(() => engine.accept(events, start + 5));
    atomic(() => engine.accept([goal('rejected', start + 6, 100)], start + 7, () => false));
    atomic(() => engine.accept([goal('rejected', start + 6, 100)], start + 8));
    const q = { kind: 'goals' as const, goalId: 'pay', from: start, to: start + H };
    expect(summaries.query(q, start + H).rows).toEqual([{ kind: 'goals', goalId: 'pay', count: 3, total: 8, mean: 8 / 3 }]);
    const e = exposure('zero', start + 10);
    atomic(() => engine.accept([e], start + 11));
    atomic(() => engine.close('s', start + 62_000, () => {}));
    const before = summaries.query({ kind: 'learning', experimentId: 'e', from: start, to: start + H }, start + H);
    expect(before.rows).toEqual([{ kind: 'learning', experimentId: 'e', armId: 'a', generation: 1, observationWindowMs: 1000, count: 1, total: 0, mean: 0 }]);
    engine.outputs(); engine.outputs();
    atomic(() => engine.close('s', start + 63_000, () => {}));
    expect(summaries.query({ kind: 'learning', experimentId: 'e', from: start, to: start + H }, start + H)).toEqual(before);
  });
});

it('requires complete coverage on occurrence/start axis and never silently rounds ranges or backfills old samples', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, ctx) => {
    const engine = new IncrementalLearning(ctx.storage.sql), summaries = engine.summaries;
    ctx.storage.transactionSync(() => engine.accept([exposure('before', start)], start));
    const cfg = { goalIds: ['pay'], experimentIds: ['e'] };
    const status = ctx.storage.transactionSync(() => summaries.configure(cfg, start + 1));
    expect(status.coverageFrom).toBe(start + H);
    ctx.storage.transactionSync(() => engine.close('s', start + H + 1, () => {}));
    expect(ctx.storage.transactionSync(() => summaries.configure(cfg, start + H + 2))).toEqual(status);
    expect(() => summaries.query({ kind: 'learning', experimentId: 'e', from: start, to: start + H }, start + 2 * H)).toThrow('not fully covered');
    expect(summaries.query({ kind: 'learning', experimentId: 'e', from: start + H, to: start + 2 * H }, start + 2 * H).rows).toEqual([]);
    expect(() => summaries.query({ kind: 'goals', goalId: 'pay', from: start + H + 1, to: start + 2 * H }, start + 2 * H)).toThrow('whole completed UTC hours');
    expect(() => summaries.query({ kind: 'goals', goalId: 'missing', from: start + H, to: start + 2 * H }, start + 2 * H)).toThrow('not configured');
    const restarted = new IncrementalLearning(ctx.storage.sql);
    expect(restarted.summaries.status(start + 2 * H)).toEqual(status);
  });
});

it('stores compensated scaled buckets, cancelling overflow and residuals only at query time', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, ctx) => {
    const engine = new IncrementalLearning(ctx.storage.sql), s = engine.summaries;
    ctx.storage.transactionSync(() => s.configure({ goalIds: ['pay'], experimentIds: [] }, start));
    const accept = (events: GoalEvent[], now: number) => ctx.storage.transactionSync(() => engine.accept(events, now));
    accept([goal('a', start, 1e308), goal('b', start + 1, 1e308)], start + 2);
    expect(() => s.query({ kind: 'goals', goalId: 'pay', from: start, to: start + H }, start + H)).toThrow('Summary total');
    accept([goal('c', start + H, -1e308)], start + H);
    expect(s.query({ kind: 'goals', goalId: 'pay', from: start, to: start + 2 * H }, start + 2 * H).rows[0]!.total).toBe(1e308);
    accept([goal('d', start + 2 * H, 1e16), goal('e', start + 2 * H + 1, 1)], start + 2 * H + 2);
    accept([goal('f', start + 3 * H, -1e16)], start + 3 * H);
    expect(s.query({ kind: 'goals', goalId: 'pay', from: start + 2 * H, to: start + 4 * H }, start + 4 * H).rows[0]!.total).toBe(1);
  });
});

it('rolls back summaries with dedup, preserves core learning at capacity and expires bounded buckets', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, ctx) => {
    const engine = new IncrementalLearning(ctx.storage.sql), s = engine.summaries;
    ctx.storage.transactionSync(() => s.configure({ goalIds: ['pay'], experimentIds: ['e'] }, start));
    const g = goal('g', start + 1, 1);
    expect(() => ctx.storage.transactionSync(() => { engine.accept([g], start + 2); throw Error('abort'); })).toThrow('abort');
    ctx.storage.transactionSync(() => engine.accept([g], start + 2));
    expect(s.query({ kind: 'goals', goalId: 'pay', from: start, to: start + H }, start + H).rows[0]!.count).toBe(1);
    // Exercise the capacity boundary without populating fifty thousand test rows.
    const state = JSON.parse(ctx.storage.sql.exec<{ data: string }>('SELECT data FROM summary_config').one().data);
    state.rows = 50_000;
    ctx.storage.sql.exec('UPDATE summary_config SET data=?', JSON.stringify(state));
    ctx.storage.transactionSync(() => engine.accept([exposure('zero', start + H + 3), goal('new-bucket', start + H, 2)], start + H + 4));
    expect(s.status(start + H).state).toBe('capacity_exceeded');
    expect(() => s.query({ kind: 'goals', goalId: 'pay', from: start, to: start + H }, start + H)).toThrow('not fully covered');
    ctx.storage.transactionSync(() => engine.close('s', start + 2 * H, () => {}));
    expect(engine.outputs().flatMap(o => o.output.records).find(r => r.record_id === 'zero')!.value).toBe(0);
    ctx.storage.transactionSync(() => engine.prune(start + RETENTION_MS + 1));
    expect(ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM summary_buckets').one().n).toBe(0);
    ctx.storage.transactionSync(() => s.configure({ goalIds: [], experimentIds: [] }, start + RETENTION_MS + 1));
    expect(s.status(start + RETENTION_MS + 1).state).toBe('disabled');
  });
});

it('exposes opt-in summaries through the SDK and service without raw analytics', async () => {
  const ctx = createExecutionContext(), eye = createEye({ ctx, service: new EyeWorker(ctx, env) });
  expect((await eye.analytics.summaries.status()).state).toBe('disabled');
  const s = await eye.analytics.summaries.configure({ goalIds: ['pay'], experimentIds: [] });
  expect(s.state).toBe('collecting');
  await expect(eye.analytics.summaries.query({ kind: 'goals', goalId: 'pay', from: 0, to: H })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('not fully covered') });
  await waitOnExecutionContext(ctx);
});

it('does not materialize an overflowing report bucket while closing valid learning samples', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, ctx) => {
    const engine = new IncrementalLearning(ctx.storage.sql), s = engine.summaries;
    ctx.storage.transactionSync(() => s.configure({ goalIds: [], experimentIds: ['e'] }, start));
    const a = exposure('a-first', start + 10), b = exposure('a-second', start + 10);
    ctx.storage.transactionSync(() => engine.accept([a, b,
      { ...goal('g1', start + 10, 1e308), subject: a.subject },
      { ...goal('g2', start + 10, 1e308), subject: b.subject }], start + 10));
    expect(ctx.storage.transactionSync(() => engine.close('s', start + 62_000, () => {}))).toBe(2);
    expect(engine.outputs().flatMap(o => o.output.records).every(r => r.value === 1e308)).toBe(true);
    expect(() => s.query({ kind: 'learning', experimentId: 'e', from: start, to: start + H }, start + H)).toThrow('Summary total');
    const c = exposure('a-third', start + H + 10);
    ctx.storage.transactionSync(() => engine.accept([c, { ...goal('g3', start + H + 10, -1e308), subject: c.subject }], start + H + 10));
    expect(ctx.storage.transactionSync(() => engine.close('s', start + H + 62_000, () => {}))).toBe(1);
    expect(s.query({ kind: 'learning', experimentId: 'e', from: start, to: start + 2 * H }, start + 2 * H).rows[0]!.total).toBe(1e308);
  });
});

it('keeps arm, generation and observation window dimensions distinct including zeros', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, ctx) => {
    const engine = new IncrementalLearning(ctx.storage.sql), s = engine.summaries;
    ctx.storage.transactionSync(() => s.configure({ goalIds: [], experimentIds: ['e'] }, start));
    const original = exposure('long', start + 10);
    const long = { ...original, assignment: { ...original.assignment, settings: { ...config, observationWindowMs: 2000 } } };
    ctx.storage.transactionSync(() => engine.accept([exposure('a', start + 10), exposure('b', start + 10, 'b'), exposure('new-gen', start + 10, 'a', 2), long], start + 10));
    ctx.storage.transactionSync(() => engine.close('s', start + 63_000, () => {}));
    const rows = s.query({ kind: 'learning', experimentId: 'e', from: start, to: start + H }, start + H).rows;
    expect(rows).toHaveLength(4);
    expect(rows.every(r => r.count === 1 && r.total === 0 && r.mean === 0)).toBe(true);
  });
});

it('reclaims expired buckets before treating a new bucket as a permanent capacity failure', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, ctx) => {
    const engine = new IncrementalLearning(ctx.storage.sql), s = engine.summaries;
    ctx.storage.transactionSync(() => s.configure({ goalIds: ['pay'], experimentIds: ['e'] }, start));
    // Recreate a full store of expired learning dimensions; verify real row-count accounting.
    ctx.storage.sql.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<50000)
      INSERT INTO summary_buckets SELECT 'learning', 'e', ?, json_array('a', n, 1000), 1, 1, 1, 0 FROM seq`, start);
    const stored = JSON.parse(ctx.storage.sql.exec<{ data: string }>('SELECT data FROM summary_config').one().data);
    stored.rows = 50000;
    ctx.storage.sql.exec('UPDATE summary_config SET data=?', JSON.stringify(stored));
    const now = start + RETENTION_MS + H;
    expect(() => ctx.storage.transactionSync(() => { engine.accept([goal('fresh', now, 7)], now); throw Error('abort'); })).toThrow('abort');
    expect(ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM summary_buckets').one().n).toBe(50000);
    ctx.storage.transactionSync(() => engine.accept([goal('fresh', now, 7)], now));
    expect(s.status(now).state).toBe('collecting');
    expect(s.query({ kind: 'goals', goalId: 'pay', from: now, to: now + H }, now + H).rows[0]!.total).toBe(7);
    const count = ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM summary_buckets').one().n;
    expect(count).toBeGreaterThanOrEqual(49001); // Reclamation remains bounded.
    expect(count).toBeLessThanOrEqual(50000);
    const after = JSON.parse(ctx.storage.sql.exec<{ data: string }>('SELECT data FROM summary_config').one().data);
    expect(after.rows).toBe(count);
  });
});

it('preserves tiny goal totals after merging a cancelled large bucket with later buckets', async () => {
  await runInDurableObject(env.SITES.getByName(crypto.randomUUID()), (_actor, ctx) => {
    const engine = new IncrementalLearning(ctx.storage.sql), s = engine.summaries;
    ctx.storage.transactionSync(() => s.configure({ goalIds: ['pay'], experimentIds: [] }, start));
    ctx.storage.transactionSync(() => engine.accept([goal('large', start, 1e308), goal('cancel', start + 1, -1e308)], start + 2));
    ctx.storage.transactionSync(() => engine.accept([goal('tiny', start + H, 1e-100)], start + H));
    const result = s.query({ kind: 'goals', goalId: 'pay', from: start, to: start + 2 * H }, start + 2 * H);
    expect(result.rows[0]).toMatchObject({ count: 3, total: 1e-100 });
    expect(result.rows[0]!.mean / 1e-100).toBeCloseTo(1 / 3, 14);
  });
});
