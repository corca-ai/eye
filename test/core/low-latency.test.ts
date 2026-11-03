import { afterEach, expect, it, vi } from 'vitest';
import { createEyeBrowser } from '../../src/browser.js';
import { decisionRuntime } from '../../src/decisions.js';
import { parseAssignment } from '../../src/core/events.js';
import { settings } from '../../src/core/validation.js';
import { rawRecords } from '../../src/analytics/raw.js';
import { BasinAnalytics } from '../../src/analytics/query.js';
import { database } from '../helpers/analytics-db.js';
import { learningDatabase } from '../helpers/learning-db.js';
import type { BrowserExposure, BrowserSnapshot } from '../../src/browser-types.js';
import type { ExposureEvent, GoalEvent } from '../../src/core/types.js';
import type { PublishedPolicy } from '../../src/transport.js';

const at = 1_800_000_000_000, secret = 'low-latency-test-secret-at-least-32-bytes';
function policy(): PublishedPolicy {
  return { installationId: 'site', experimentId: 'exp', generation: 1, revision: 1, statsAsOf: at,
    settings: settings({ minHoldMs: 0, observationWindowMs: 1000, attributionHalfLifeMs: 1000000 }),
    asOf: at, scoreScale: 1, publishedAt: at, sequence: 1, status: 'active', activeArms: ['a', 'b'],
    arms: ['a', 'b'].map(armId => ({ armId, weight: 10, meanReward: 1, score: 1, probability: armId === 'b' ? 1 : 0 })) };
}
function snapshot(): BrowserSnapshot {
  const choice = { experimentId: 'exp', armId: 'a', receipt: 'default', applyUntil: at + 10000,
    assignmentId: 'default-assignment', observationWindowMs: 1000 };
  return { scope: 'anonymous', serverNow: at, choices: [], defaults: [choice] };
}
const definition = { experimentId: 'exp', defaultArm: 'a', variants: { a: 'default-value', b: 'policy-value' } };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('counts a default with no policy lookup, reuses its sample, and keeps policy hold state separate', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(at);
  const service = { getPublishedPolicy: vi.fn(async () => policy()) }, pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
  const runtime = decisionRuntime(service, ctx, { secret, initialPolicies: [policy()] }, () => {});
  const weighted = await runtime.decide({ cid: 'c' }, 'exp');
  const first = await runtime.decideDefault({ cid: 'c' }, 'exp', 'a');
  expect(weighted).toMatchObject({ status: 'assigned', assignment: { armId: 'b', probability: 1 } });
  if (first.status !== 'assigned') throw new Error('Expected default');
  expect(parseAssignment(first.assignment)).toMatchObject({ allocation: 'default', probability: null, policyRevision: null });
  const exposure = runtime.expose(first, at, 'shown');
  const next = decisionRuntime(service, ctx, { secret, initialPolicies: [policy()], tokens: await runtime.state(), defaultTokens: await runtime.defaultState() }, () => {});
  const held = await next.decideDefault({ cid: 'c' }, 'exp', 'a');
  expect(held).toMatchObject({ status: 'assigned', assignment: { assignmentId: first.assignment.assignmentId }, localContext: { sample: { sampleId: exposure.sampleId } } });
  expect(await next.decide({ cid: 'c' }, 'exp')).toMatchObject({ status: 'assigned', assignment: { armId: 'b' } });
  expect(service.getPublishedPolicy).not.toHaveBeenCalled();
  await Promise.all(pending);
});

it('cannot authorize a default from inactive, missing-arm, future or expired authority', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(at);
  for (const supplied of [{ ...policy(), status: 'paused' as const }, { ...policy(), publishedAt: at + 1 },
    { ...policy(), publishedAt: at - 21600000 }]) {
    const runtime = decisionRuntime({ getPublishedPolicy: async () => supplied }, { waitUntil() {} }, { secret, initialPolicies: [supplied] }, () => {});
    expect((await runtime.decideDefault({ cid: 'c' }, 'exp', 'a')).status).not.toBe('assigned');
  }
  const runtime = decisionRuntime({ getPublishedPolicy: async () => policy() }, { waitUntil() {} }, { secret, initialPolicies: [policy()] }, () => {});
  expect((await runtime.decideDefault({ cid: 'c' }, 'exp', 'missing')).status).toBe('no_active_arm');
});

it('applies a synchronous default once, never repaints the occurrence on late policy preparation', async () => {
  vi.useFakeTimers({ now: at });
  let release!: (value: BrowserSnapshot) => void;
  const events: BrowserExposure[] = [];
  const client = createEyeBrowser({ scope: 'anonymous', initial: snapshot(),
    prepare: () => new Promise(resolve => { release = resolve; }),
    send: async batch => { events.push(...batch); return batch.map(e => ({ eventId: e.eventId, accepted: true })); } });
  try {
    const view = client.beginView(), first = view.variant(definition);
    expect(first.armId).toBe('a'); expect(first.value).toBe('default-value');
    expect(first.expose()).toBe(true); expect(first.expose()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    release({ ...snapshot(), defaults: [], choices: [{ ...snapshot().defaults![0]!, armId: 'b', receipt: 'policy', assignmentId: 'policy' }] });
    await vi.advanceTimersByTimeAsync(1);
    expect(view.variant(definition)).toBe(first);
    expect(client.beginView().variant(definition).armId).toBe('b');
    await client.flush(); expect(events).toHaveLength(1); expect(events[0]!.defaultReason).toBe('unprepared');
  } finally { client.dispose(); }
});

it('resource fallback invalidates the old handle and cannot retry an already-applied action', async () => {
  vi.useFakeTimers({ now: at });
  const initial = snapshot(); initial.choices.push({ ...initial.defaults![0]!, armId: 'b', receipt: 'policy', assignmentId: 'policy' });
  const client = createEyeBrowser({ scope: 'anonymous', initial });
  try {
    const first = client.beginView().variant(definition), actual = first.useDefault('resource_unready');
    expect(first.armId).toBe('b'); expect(actual.armId).toBe('a'); expect(first.expose()).toBe(false);
    expect(actual.expose()).toBe(true); expect(() => actual.useDefault('resource_unready')).toThrow('applied');
  } finally { client.dispose(); }
});

it('bounded preparation freezes default at deadline and returns a later policy only in a new view', async () => {
  vi.useFakeTimers({ now: at });
  let release!: (value: BrowserSnapshot) => void;
  const client = createEyeBrowser({ scope: 'anonymous', initial: snapshot(), prepare: () => new Promise(resolve => { release = resolve; }) });
  try {
    const view = client.beginView();
    const waiting = view.variantAsync(definition, { maxWaitMs: 5 });
    await vi.advanceTimersByTimeAsync(6); expect((await waiting).armId).toBe('a');
    release({ ...snapshot(), choices: [{ ...snapshot().defaults![0]!, armId: 'b' }] });
    await vi.advanceTimersByTimeAsync(1);
    expect(view.variant(definition).armId).toBe('a'); expect(client.beginView().variant(definition).armId).toBe('b');
  } finally { client.dispose(); }
});

it('default goal attribution supersedes B and feeds its arm without inflating competing rewards', async () => {
  const setting = policy().settings;
  const make = (key: string, armId: string, time: number, defaults = false, experimentId = 'exp'): ExposureEvent => ({
    kind: 'exposure', eventId: key, occurredAt: time, subject: { cid: 'c' }, sample: { sampleId: key, startAt: time }, attributionWindowMs: 10000,
    assignment: { assignmentId: key, experimentId, armId, generation: 1, assignedAt: time, settings: setting,
      ...(defaults ? { allocation: 'default' as const, policyRevision: null, probability: null, authorityRevision: 1 }
        : { policyRevision: 1, probability: 1 }) } });
  const b = make('b', 'b', at), a = make('default-a', 'a', at + 1, true), other = make('other', 'a', at, false, 'other');
  const goal: GoalEvent = { kind: 'goal', eventId: 'paid', occurredAt: at + 2, subject: { cid: 'c' }, goalId: 'pay', value: 100 };
  const events = [b, other, a, goal], learning = learningDatabase();
  const records = events.flatMap(event => rawRecords({ siteId: 'site', receivedAt: at + 3, event }));
  try {
    learning.engine.accept(events, at + 3);
    let moments: import('../../src/core/closed-cohort.js').ClosedCohort['arms'] = [];
    learning.engine.close('site', at + 62000, cohort => { moments = [...moments, ...cohort.arms]; });
    for (const row of learning.engine.outputs()) records.push(...row.output.records);
    expect(moments.map(m => [m.experimentId, m.armId])).toEqual(expect.arrayContaining([['exp', 'b'], ['other', 'a']]));
    expect(moments.find(m => m.experimentId === 'exp' && m.armId === 'a')!.samples).toBe(1);
    const db = database(records);
    try {
      const api = new BasinAnalytics({ EYE_ANALYTICS_WAREHOUSE: `${'a'.repeat(32)}_eye-data`, EYE_ANALYTICS_TOKEN: 'test' }, 'site', db.request, () => at + 62000);
      const report = await api.arms({ from: at, to: at + 62000, experimentId: 'exp' });
      expect(report.rows.find(r => r.allocationMode === 'policy')!.totalValue).toBe(0);
      const defaultRow = report.rows.find(r => r.allocationMode === 'default')!;
      expect(defaultRow.completed).toBe(1); expect(defaultRow.totalValue).toBeCloseTo(50, 3); expect(defaultRow.learningValue).toBeCloseTo(50, 3);
      const frozen = await api.learning({ from: at, to: at + 62000 });
      expect(frozen.allocationMode).toBe('all');
      expect(frozen.rows.find(r => r.experimentId === 'exp' && r.armId === 'a')).toMatchObject({ completed: 1, learningValue: defaultRow.learningValue });
      expect((await api.traffic({ from: at, to: at + 62000, experimentId: 'exp', bucketMs: 60000 })).rows.map(r => r.allocationMode)).toEqual(expect.arrayContaining(['policy', 'default']));
    } finally { db.close(); }
  } finally { learning.close(); }
});

it.each([false, true])('preserves default observations when initial bootstrap is installed on reload (fresh assignment: %s)', async freshAssignment => {
  vi.useFakeTimers({ now: at });
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
  const initial = snapshot(); initial.defaults![0]!.contextKey = 'same-identity-and-default-semantics';
  const events: BrowserExposure[] = [];
  const send = async (batch: BrowserExposure[]) => { events.push(...batch); return batch.map(e => ({ eventId: e.eventId, accepted: true })); };
  const first = createEyeBrowser({ scope: 'anonymous', initial, storage, send });
  first.beginView().variant(definition).expose(); await first.flush(); first.dispose();
  await vi.advanceTimersByTimeAsync(10);
  const nextSnapshot = structuredClone(initial); nextSnapshot.serverNow += 10;
  if (freshAssignment) { nextSnapshot.defaults![0]!.assignmentId = 'new-navigation-assignment'; nextSnapshot.defaults![0]!.receipt = 'new-navigation-receipt'; }
  const second = createEyeBrowser({ scope: 'anonymous', initial: nextSnapshot, storage, send });
  try {
    expect(second.beginView().variant(definition).expose()).toBe(true); await second.flush();
    expect(events).toHaveLength(2); expect(events[1]!.sample).toEqual(events[0]!.sample);
    expect(events[1]!.receipt).toBe(events[0]!.receipt);
  } finally { second.dispose(); }
});

it('explicit preparation drains every requested ID across byte-bounded renewal batches', async () => {
  vi.useFakeTimers({ now: at });
  const ids = ['first', 'second', 'third'];
  const choice = (experimentId: string) => ({ experimentId, armId: 'a', receipt: 'x'.repeat(9000), applyUntil: at + 100000 });
  const initial: BrowserSnapshot = { scope: 'anonymous', serverNow: at, choices: ids.map(choice), defaults: ids.map(choice) };
  const requests: string[][] = [];
  const client = createEyeBrowser({ scope: 'anonymous', initial, prepare: async (experimentIds, states, defaults) => {
    expect(new TextEncoder().encode(JSON.stringify({ experimentIds, states, defaultStates: defaults })).length).toBeLessThanOrEqual(48000);
    requests.push(experimentIds);
    return { scope: 'anonymous', serverNow: Date.now(), choices: experimentIds.map(choice), defaults: experimentIds.map(choice) };
  } });
  try {
    const prepared = client.prepare(ids); await vi.advanceTimersByTimeAsync(5001);
    expect(await prepared).toEqual({ first: 'assigned', second: 'assigned', third: 'assigned' });
    expect(requests).toHaveLength(2); expect(requests.flat().sort()).toEqual(ids.sort());
  } finally { client.dispose(); }
});

it('an unsupported policy arm cannot become counted default through explicit replacement', () => {
  vi.useFakeTimers({ now: at });
  const initial = snapshot(); initial.choices = [{ ...initial.defaults![0]!, armId: 'unsupported' }];
  const client = createEyeBrowser({ scope: 'anonymous', initial });
  try {
    const selected = client.beginView().variant(definition);
    expect(selected.armId).toBeNull(); expect(selected.useDefault('resource_unready').armId).toBeNull();
    expect(selected.useDefault('resource_unready').expose()).toBe(false);
  } finally { client.dispose(); }
});

it('collection saturation does not allow an applied client action to be retried through default', () => {
  vi.useFakeTimers({ now: at });
  const initial = snapshot(); initial.choices = [{ ...initial.defaults![0]!, armId: 'b', assignmentId: 'policy' }];
  const client = createEyeBrowser({ scope: 'anonymous', initial });
  try {
    for (let i = 0; i < 100; i++) expect(client.beginView().variant(definition).expose()).toBe(true);
    const applied = client.beginView().variant(definition);
    expect(applied.expose()).toBe(false);
    expect(() => applied.useDefault('resource_unready')).toThrow('applied');
  } finally { client.dispose(); }
});
