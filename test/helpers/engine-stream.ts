import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { IncrementalLearning, type LearningSQL } from '../../src/runtime/incremental.js';
import { selectLocal, exposeLocal, type LocalPolicy } from '../../src/core/local-assignment.js';
import { evaluateUnreservedPolicy } from '../../src/core/policy.js';
import { ageMoments, emptyMoments, mergeMoments, type Moments } from '../../src/core/moments.js';
import { parseEnvelope } from '../../src/core/events.js';
import { settings } from '../../src/core/validation.js';
import type { EyeEvent, Subject } from '../../src/core/types.js';

export const HOUR = 3_600_000, DAY = 24 * HOUR, START = 1_800_000_000_000;
export const streamSettings = settings({ minHoldMs: 30 * 60_000, observationWindowMs: 10 * 60_000,
  allowedLatenessMs: 2 * 60_000, attributionWindowMs: HOUR, attributionHalfLifeMs: HOUR,
  learningHalfLifeMs: 12 * HOUR });
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
export function store() {
  const db = new DatabaseSync(':memory:');
  const sql: LearningSQL = { exec<T extends Record<string, string | number | null>>(query: string, ...bindings: (string | number | null)[]) {
    let rows: T[];
    if (query.trimStart().startsWith('CREATE ')) { db.exec(query); rows = []; }
    else rows = db.prepare(query).all(...bindings) as T[];
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  const engine = new IncrementalLearning(sql);
  const atomic = <T>(work: () => T): T => {
    db.exec('BEGIN');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return { db, engine, atomic };
}
export interface StreamBatch { now: number; events: EyeEvent[] }
export interface Scenario {
  seed: number; visits: number; days: number; kind: 'aa' | 'ab' | 'switch';
  uniform?: boolean; ordered?: boolean; scale?: number; capture?: boolean;
}

/** Virtual clock drives real selection, SQLite learning, close/outbox and policy math.
 * No network/disk timing is represented. Policy refresh is modeled at 15 minutes.
 */
export function simulate(input: Scenario) {
  const { db, engine, atomic } = store();
  const behavior = random(input.seed), delivery = random(input.seed ^ 0x9e3779b9);
  const cfg = { ...streamSettings, rewardScale: streamSettings.rewardScale * (input.scale ?? 1),
    explorationFloor: input.uniform ? 1 : streamSettings.explorationFloor };
  const moments = new Map<string, Moments>(), pending = new Map<number, EyeEvent[]>();
  const batches: StreamBatch[] = [], events: EyeEvent[] = [], observations = new Map<string, number>();
  const selected: string[] = [], deliveredIds = new Set<string>();
  const counts = { a: 0, b: 0 }, purchases = { a: 0, b: 0 };
  const phases = [{ a: 0, b: 0 }, { a: 0, b: 0 }, { a: 0, b: 0 }, { a: 0, b: 0 }];
  const diagnostics = { staleExposures: 0, staleIdentities: 0, futureExposures: 0, closedGoals: 0 };
  let alarm: number | null = null, policy: LocalPolicy | undefined, sequence = 0;
  let deliveries = 0, duplicates = 0, delayed = 0, refunds = 0, alarms = 0;
  const end = START + input.days * DAY;
  const schedule = (now: number) => {
    const next = engine.nextWake(now);
    if (next !== null && (alarm === null || next < alarm)) alarm = next;
  };
  const flush = (now: number) => {
    alarms++;
    atomic(() => { engine.prune(now); engine.close('site', now); });
    for (const { id, output } of engine.outputs()) {
      for (const row of output.records) {
        assert.ok(!observations.has(row.record_id), 'one completion per sample');
        assert.ok(Number.isFinite(row.value), 'finite completed reward');
        observations.set(row.record_id, row.value!);
      }
      for (const arm of output.cohort.arms) {
        const old = moments.get(arm.armId) ?? emptyMoments(now);
        moments.set(arm.armId, mergeMoments(ageMoments(old, now, cfg.learningHalfLifeMs), arm.moments));
      }
      atomic(() => engine.acknowledge([id]));
    }
    alarm = engine.nextWake(now, true);
  };
  const drain = (until: number) => {
    for (;;) {
      const nextBatch = Math.min(...pending.keys()), next = Math.min(nextBatch, alarm ?? Infinity);
      if (next > until) return;
      if (alarm !== null && alarm <= nextBatch) { flush(alarm); continue; }
      const all = pending.get(nextBatch)!; pending.delete(nextBatch);
      // Queue messages can arrive in a different order; engine sorts each received chunk.
      for (let offset = 0; offset < all.length; offset += 100) {
        const chunk = all.slice(offset, offset + 100);
        const receipt = atomic(() => engine.accept(chunk, nextBatch));
        assert.ok(receipt.accepted.every(Boolean), 'valid synthetic events accepted');
        for (const key of Object.keys(diagnostics) as (keyof typeof diagnostics)[]) diagnostics[key] += receipt.diagnostics[key];
        if (input.capture) batches.push({ now: nextBatch, events: chunk });
        deliveries += chunk.length;
        for (const event of chunk) deliveredIds.add(event.eventId);
      }
      schedule(nextBatch);
    }
  };
  const emit = (event: EyeEvent) => {
    const delay = input.ordered ? 0 : delivery() < .02 ? (delayed++, 10_000 + Math.floor(delivery() * 80_000)) : Math.floor(delivery() * 1000);
    const arrival = Math.ceil((event.occurredAt + delay) / 5000) * 5000;
    parseEnvelope({ siteId: 'site', receivedAt: event.occurredAt, event }, arrival);
    if (input.capture) events.push(event);
    const batch = pending.get(arrival) ?? [];
    batch.push(event);
    if (!input.ordered && delivery() < .03) { batch.push(event); duplicates++; }
    pending.set(arrival, batch);
  };
  // Mostly daytime traffic, with a smaller overnight population. Sort visit times,
  // but never reveal a future outcome to the policy making the current assignment.
  const starts = Array.from({ length: input.visits }, (_, i) => {
    const day = Math.floor(i * input.days / input.visits);
    const hour = behavior() < .75 ? 9 + behavior() * 12 : behavior() * 24;
    return START + day * DAY + Math.floor(hour * HOUR);
  }).sort((a, b) => a - b);
  try {
    atomic(() => engine.summaries.configure({ goalIds: ['purchase', 'refund'], experimentIds: ['checkout'] }, START - HOUR));
    for (const [index, at] of starts.entries()) {
      drain(at);
      if (!policy || at >= policy.freshUntil) {
        const evaluated = evaluateUnreservedPolicy(['a', 'b'].map(armId => ({ armId, moments: moments.get(armId) ?? emptyMoments(at) })),
          { ...cfg, bootstrapShare: cfg.bootstrapShare! }, at);
        assert.ok(Math.abs(evaluated.arms.reduce((sum, arm) => sum + arm.probability, 0) - 1) < 1e-12);
        for (const arm of evaluated.arms) {
          assert.ok(Number.isFinite(arm.score) && Number.isFinite(arm.meanReward));
          assert.ok(arm.probability >= cfg.explorationFloor / 2 - 1e-12);
        }
        policy = { ...evaluated, siteId: 'site', experimentId: 'checkout', generation: 1, revision: 1,
          sequence: ++sequence, publishedAt: at, freshUntil: at + 15 * 60_000, usableUntil: at + 6 * HOUR,
          active: true, settings: cfg, attributionWindowMs: HOUR };
      }
      const prefix = `s${input.seed}-v${index}`, cid = `browser-${prefix}`, uid = `user-${prefix}`;
      const auth = behavior(), device = behavior() < .65 ? 'mobile' : 'desktop';
      const subject: Subject = auth < .3 ? { cid, uid } : { cid };
      const selection = selectLocal({ siteId: 'site', experimentId: 'checkout', subject, now: at, policy, newId: () => prefix });
      assert.equal(selection.status, 'assigned');
      if (selection.status !== 'assigned') throw new Error('Expected active arm');
      const arm = selection.context.assignment.armId as 'a' | 'b';
      counts[arm]++; selected.push(arm);
      const phase = Math.min(3, Math.floor(4 * (at - START) / (end - START)));
      phases[phase]![arm]++;
      const { exposure: first } = exposeLocal(selection, at, `${prefix}-exposure-0`);
      const sample = { sampleId: first.sampleId, startAt: first.startAt };
      for (const [j, elapsed] of [0, 30_000, 60_000].entries()) emit({ ...first.event, eventId: `${prefix}-exposure-${j}`,
        occurredAt: at + elapsed, sample, attributionWindowMs: HOUR, userAttributes: { device, locale: 'ko', returning: index % 4 === 0 } });
      let goalSubject = subject;
      if (auth >= .3 && auth < .6) {
        goalSubject = { cid, uid };
        emit({ kind: 'identify', eventId: `${prefix}-login`, occurredAt: at + 75_000, subject: goalSubject });
      }
      for (let j = 0; j < 4; j++) emit({ kind: 'track', eventId: `${prefix}-track-${j}`, occurredAt: at + j * 30_000,
        subject: j === 3 ? goalSubject : subject, name: ['page_view', 'scroll', 'product_view', 'checkout'][j]!, attributes: { device, path: '/shop' } });
      const better = input.kind === 'switch' && at >= START + (end - START) / 2 ? 'a' : 'b';
      const rate = (input.kind === 'aa' ? .25 : arm === better ? .5 : .1) * (device === 'mobile' ? .9 : 1.1);
      // Reward RNG is separate from allocation hashing and delivery fault RNG.
      const purchase = behavior() < rate, value = (behavior() < .9 ? 20 : 100) * (input.scale ?? 1);
      const refund = behavior() < .1;
      if (purchase) {
        purchases[arm]++;
        if (goalSubject.uid && index % 5 === 0) goalSubject = { ...goalSubject, cid: `second-device-${prefix}` };
        emit({ kind: 'goal', eventId: `${prefix}-purchase`, occurredAt: at + 120_000, subject: goalSubject, goalId: 'purchase', value });
        if (refund) { refunds++; emit({ kind: 'goal', eventId: `${prefix}-refund`, occurredAt: at + 240_000, subject: goalSubject, goalId: 'refund', value: -value / 2 }); }
      }
      if (auth < .6) emit({ kind: 'logout', eventId: `${prefix}-logout`, occurredAt: at + 300_000, subject: { cid } });
    }
    drain(end + HOUR);
    assert.equal(observations.size, input.visits, 'all exposed visits complete including zero reward');
    assert.equal(engine.outputs().length, 0, 'outbox drained');
    const from = Math.ceil(START / HOUR) * HOUR, to = Math.floor(end / HOUR) * HOUR;
    const summary = engine.summaries.query({ kind: 'learning', experimentId: 'checkout', from, to }, end + HOUR);
    const covered = [...observations.entries()].filter(([id]) => {
      const index = Number(id.match(/-v(\d+)/)![1]); return starts[index]! >= from && starts[index]! < to;
    });
    assert.equal(summary.rows.reduce((sum, row) => sum + row.count, 0), covered.length);
    const expected = covered.reduce((sum, [, reward]) => sum + reward, 0);
    assert.ok(Math.abs(summary.rows.reduce((sum, row) => sum + row.total, 0) - expected) <= 1e-9 * Math.max(1, Math.abs(expected)));
    const credited = { a: { sum: 0, squares: 0 }, b: { sum: 0, squares: 0 } };
    for (const [id, reward] of observations) {
      const arm = selected[Number(id.match(/-v(\d+)/)![1])] as 'a' | 'b';
      credited[arm].sum += reward; credited[arm].squares += reward * reward;
    }
    return { seed: input.seed, counts, purchases, phases, deliveries, uniqueEvents: deliveredIds.size, duplicates, delayed, refunds, alarms, diagnostics,
      credited,
      zeroSamples: [...observations.values()].filter(value => value === 0).length, samples: observations.size,
      selected, observations, events, batches, settings: cfg, end };
  } finally { db.close(); }
}
