import {DatabaseSync} from 'node:sqlite';
import {expect, it} from 'vitest';
import {Dashboard} from '../../src/runtime/dashboard.js';
import {IncrementalLearning, type LearningSQL} from '../../src/runtime/incremental.js';
import {settings} from '../../src/core/validation.js';
import type {EyeEvent, ExposureEvent} from '../../src/core/types.js';
const minute = 60_000, start = 10 * minute;
function fixture() {
  const db = new DatabaseSync(':memory:');
  const sql: LearningSQL = {exec<T extends Record<string, string | number | null>>(query: string, ...bindings: (string | number | null)[]) {
    if (!bindings.length && query.includes(';')) { db.exec(query); return {toArray: () => [] as T[], *[Symbol.iterator]() {}}; }
    const rows = db.prepare(query).all(...bindings) as T[];
    return {toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]()};
  }};
  return {db, sql};
}
function exposure(eventId: string, occurredAt: number, experimentId = 'landing'): ExposureEvent {
  return {kind: 'exposure', eventId, occurredAt, subject: {cid: 'browser'}, assignment: {
    assignmentId: `assignment:${experimentId}`, experimentId, armId: 'original', generation: 1, policyRevision: 1,
    assignedAt: occurredAt, probability: 1, settings: settings({minHoldMs: 0, observationWindowMs: minute, attributionHalfLifeMs: minute})},
    sample: {sampleId: `sample:${experimentId}:${occurredAt}`, startAt: occurredAt}, attributionWindowMs: minute};
}
it('materializes all goals once using learning identity, splitting and decay, surviving reactivation', () => {
  const {db,sql} = fixture();
  try {
    const engine = new IncrementalLearning(sql, start);
    const accept = (events: EyeEvent[]) => engine.accept(events, start + 20);
    accept([exposure('shown', start), {kind: 'anonymous', eventId: 'initial', occurredAt: start + 1, subject: {cid: 'browser'}}]);
    accept([{kind: 'identify', eventId: 'login', occurredAt: start + 2, subject: {cid: 'browser', uid: 'account'}}]);
    const goals: EyeEvent[] = [
      {kind:'goal', eventId: 'signup', occurredAt: start + 3, subject: {cid: 'server:account', uid: 'account'}, goalId: 'signup', value: 1000},
      {kind:'goal', eventId: 'loss', occurredAt: start + 4, subject: {cid: 'server:account', uid: 'account'}, goalId: 'delete', value: -200}];
    accept(goals); accept(goals);
    const report = new IncrementalLearning(sql, start + minute).dashboard.query({experimentId:'landing', boundaries: [start, start + minute]}, start + minute);
    expect(report.rewards).toHaveLength(2);
    expect(report.rewards.find(row => row.goalId === 'signup')!.totalValue).toBeCloseTo(1000 * 2 ** (-3 / minute));
    expect(report.rewards.find(row => row.goalId === 'delete')!.totalValue).toBeCloseTo(-200 * 2 ** (-4 / minute));
    expect(report.traffic).toEqual([{bucketStart:start, armId:'original', generation:1, assignments:1, exposures:1}]);
    expect(report.meta.coverageFrom).toBe(start);
    expect(report.meta.basis).toBe('processed_learning');
    // Ordinary reads need neither raw event tables nor a network collaborator.
    expect(report.meta.lastProcessedAt).toBe(start + 20);
  } finally {db.close();}
});
it('excludes rejected goals, preserves explicit logout and exposes delayed-data diagnostics', () => {
  const {db,sql} = fixture();
  try {
    const engine = new IncrementalLearning(sql,start), accept = (events: EyeEvent[], now = start + 20) => engine.accept(events,now);
    accept([exposure('shown',start), {kind:'logout',eventId:'logout',occurredAt:start + 1,subject:{cid:'browser'}},
      {kind:'identify',eventId:'login',occurredAt:start + 2,subject:{cid:'browser',uid:'account'}},
      {kind:'goal',eventId:'unlinked',occurredAt:start + 3,subject:{cid:'server:account',uid:'account'},goalId:'signup',value:1000}]);
    accept([exposure('older',start - 1)]);
    const result = engine.dashboard.query({experimentId:'landing',boundaries:[start,start + minute]},start + minute);
    expect(result.rewards).toEqual([]);
    expect(result.meta.diagnostics.staleExposures).toBe(0);
    expect(() => engine.dashboard.query({experimentId:'landing',boundaries:[start + 1,start + minute]},start + minute)).toThrow('whole minutes');
  } finally {db.close();}
});

it('shares rewards across eligible experiments and exposes excluded closed-observation goals', () => {
  const {db,sql} = fixture();
  try {
    const engine = new IncrementalLearning(sql,start);
    engine.accept([exposure('a',start,'a'),exposure('b',start,'b'),
      {kind:'goal',eventId:'shared',occurredAt:start+1,subject:{cid:'browser'},goalId:'pay',value:100}],start+2);
    const query = (experimentId: string) => engine.dashboard.query({experimentId,boundaries:[start,start+minute]},start+minute);
    expect(query('a').rewards[0]!.totalValue).toBeCloseTo(50 * 2 ** (-1 / minute));
    expect(query('b').rewards[0]!.totalValue).toBe(query('a').rewards[0]!.totalValue);
    engine.accept([{kind:'goal',eventId:'rejected',occurredAt:start+3,subject:{cid:'browser'},goalId:'pay',value:1000}],start+4,()=>false);
    expect(query('a').rewards[0]!.goals).toBe(1);
    engine.close('site',start + 2*minute,()=>{});
    expect(query('a').learning[0]!.learningValue).toBe(query('a').rewards[0]!.totalValue);
    engine.accept([{kind:'goal',eventId:'late',occurredAt:start+4,subject:{cid:'browser'},goalId:'pay',value:1000}],start+3*minute);
    expect(query('a').meta.diagnostics.closedGoals).toBe(2);
    expect(query('a').rewards[0]!.goals).toBe(1);
  } finally {db.close();}
});
it('bounds retention and coverage without inventing a pre-deployment zero series', () => {
  const {db,sql} = fixture();
  try {
    const engine = new IncrementalLearning(sql,start+1);
    engine.accept([exposure('early',start+2)],start+3);
    const q = {experimentId:'landing',boundaries:[start,start+minute,start+2*minute]};
    expect(engine.dashboard.query(q,start+2*minute).meta.coverageFrom).toBe(start+minute);
    expect(engine.dashboard.query(q,start+2*minute).traffic).toEqual([]);
    engine.accept([exposure('covered',start+minute)],start+minute+1);
    expect(engine.dashboard.query(q,start+2*minute).traffic[0]!.exposures).toBe(1);
    engine.prune(start+61*86_400_000);
    expect(sql.exec('SELECT * FROM dashboard_buckets').toArray()).toHaveLength(0);
    expect(sql.exec('SELECT * FROM dashboard_seen').toArray()).toHaveLength(0);
  } finally {db.close();}
});

it('anonymous checks advance assertion order without moving the anonymous segment fence', () => {
  const {db,sql} = fixture();
  try {
    const engine = new IncrementalLearning(sql,start);
    const identity = (kind: 'identify' | 'anonymous' | 'logout', at: number, uid?: string): EyeEvent => ({kind,eventId:`${kind}:${at}`,occurredAt:start+at,subject:{cid:'browser',...(uid ? {uid} : {})}});
    engine.accept([identity('logout',1)],start+2);
    engine.accept([identity('anonymous',30)],start+31);
    // An exposure from before the check still belongs to the same anonymous segment.
    engine.accept([exposure('shown',start+20)],start+32);
    const stale = engine.accept([identity('identify',10,'old')],start+33);
    expect(stale.diagnostics.staleIdentities).toBe(1);
    engine.accept([identity('identify',40,'new'),{kind:'goal',eventId:'new-goal',occurredAt:start+41,subject:{cid:'server:new',uid:'new'},goalId:'signup',value:1000}],start+42);
    expect(engine.dashboard.query({experimentId:'landing',boundaries:[start,start+minute]},start+minute).rewards[0]!.goals).toBe(1);
  } finally {db.close();}
});

it('schedules expiry for policy-only activity even after caching an empty retention deadline', () => {
  const {db,sql} = fixture();
  try {
    const engine = new IncrementalLearning(sql,start);
    expect(engine.nextWake(start)).toBeNull();
    Dashboard.recordPolicy(sql,{experimentId:'landing',installationId:'site',generation:1,revision:1,
      asOf:start,publishedAt:start,sequence:1,statsAsOf:null,scoreScale:1000,status:'active',activeArms:['a'],settings:settings({minHoldMs:0}),
      arms:[{armId:'a',weight:0,meanReward:0,score:0,probability:1}]},[{armId:'a',status:'active'},{armId:'paused',status:'paused'}]);
    expect(engine.nextWake(start)).not.toBeNull();
    const report = engine.dashboard.query({experimentId:'landing',boundaries:[start,start+minute]},start+minute);
    expect(report.policies.map(row => row.probability)).toEqual([1,0]);
    engine.prune(start+61*86_400_000);
    expect(sql.exec('SELECT * FROM dashboard_policies').toArray()).toHaveLength(0);
  } finally {db.close();}
});
