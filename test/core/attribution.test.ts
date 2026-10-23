import { describe, expect, it } from 'vitest';
import { attributeGoal, compareEvents, lastExposureBefore } from '../../src/core/attribution.js';
import { canReassign, closeObservation, interruptObservation, openObservation } from '../../src/core/observation.js';
import { settings, subjectKey } from '../../src/core/validation.js';
import { parseEnvelope, parseEvent } from '../../src/core/events.js';
import type { Assignment, Exposure } from '../../src/core/types.js';

const config = settings({ minHoldMs: 100, observationWindowMs: 1000, attributionHalfLifeMs: 100, allowedLatenessMs: 10 });
const assignment = (experimentId: string, armId = 'a'): Assignment => ({ assignmentId: `assign:${experimentId}:${armId}`, experimentId, armId, generation: 1, assignedAt: 0, policyRevision: 1, probability: 0.5, settings: config });
const expose = (experimentId: string, at: number, armId = 'a'): Exposure => ({ eventId: `${experimentId}:${armId}:${at}`, occurredAt: at, assignment: assignment(experimentId, armId), observationId: null });

describe('global reward attribution', () => {
  it('orders equal-time identifiers by Unicode code point, matching SQLite BINARY collation', () => {
    expect([{ occurredAt: 1, eventId: '\u{10000}' }, { occurredAt: 1, eventId: '\uE000' }].sort(compareEvents).map(e => e.eventId)).toEqual(['\uE000', '\u{10000}']);
  });
  it('splits each signed goal equally, decays each share, and never redistributes', () => {
    const credits = attributeGoal({ eventId: 'refund', occurredAt: 100, value: -100 }, [expose('x', 0), expose('y', 100)], new Map());
    expect(credits.map(c => c.baseValue)).toEqual([-50, -50]);
    expect(credits.map(c => c.value)).toEqual([-25, -50]);
    expect(credits.map(c => c.experimentCount)).toEqual([2, 2]);
  });
  it('last-touch search handles out-of-order arrival and excludes future exposures', () => {
    const history = [expose('x', 800, 'c'), expose('x', 400, 'b'), expose('x', 0, 'a')].sort(compareEvents);
    expect(lastExposureBefore(history, 600)?.assignment.armId).toBe('b');
    expect(lastExposureBefore(history, 400)?.assignment.armId).toBe('b');
    expect(lastExposureBefore(history, -1)).toBeUndefined();
  });
  it('keeps outside-window credits in accounting but out of fixed-horizon training', () => {
    const obs = openObservation(assignment('x'), 's', 'e', 10, {});
    const exposure = { ...expose('x', 10), observationId: obs.observationId };
    const observations = new Map([[obs.observationId, obs]]);
    const goal = { eventId: 'g', occurredAt: 1009, value: 100 };
    expect(attributeGoal(goal, [exposure], observations)[0]?.learningEligible).toBe(true);
    const outside = attributeGoal({ ...goal, occurredAt: 1010 }, [exposure], observations)[0]!;
    expect(outside.value).toBeGreaterThan(0);
    expect(outside.learningEligible).toBe(false);
  });
  it('does not treat an interrupted window as a completed zero', () => {
    const obs = openObservation(assignment('x'), 's', 'e', 10, {});
    const interrupted = interruptObservation(obs, 500, 'identity');
    expect(closeObservation(interrupted, 5000, 10).status).toBe('interrupted');
    expect(interruptObservation(obs, obs.endAt, 'arm_stopped')).toBe(obs);
    expect(canReassign(assignment('x'), obs, 999)).toBe(false);
    expect(canReassign(assignment('x'), obs, obs.endAt)).toBe(true);
    expect(closeObservation(obs, 1019, 10).status).toBe('pending');
    expect(closeObservation(obs, 1020, 10).status).toBe('complete');
  });
});

describe('public input boundaries', () => {
  it('rejects malformed Unicode identifiers before they reach UTF-8 storage', () => {
    expect(() => parseEvent({ kind: 'track', eventId: '\uD800', name: 'page', occurredAt: 1, subject: { cid: 'c' } })).toThrow();
  });
  it('rejects an exposure before its own assignment during local validation', () => {
    expect(() => parseEvent({ kind: 'exposure', eventId: 'e', occurredAt: 1, subject: { cid: 'c' }, assignment: { ...assignment('x'), assignedAt: 2 } })).toThrow('predates');
  });
  it('requires a supplied finite goal value without imposing a reward range', () => {
    const goal = { kind: 'goal', eventId: 'g', goalId: 'purchase', occurredAt: 100, subject: { cid: 'c' }, value: -1e300 };
    expect(parseEvent(goal)).toMatchObject({ value: -1e300 });
    for (const value of [NaN, Infinity, -Infinity, '100', undefined]) expect(() => parseEvent({ ...goal, value })).toThrow();
  });
  it('snapshots user attributes rather than retaining a caller-owned reference', () => {
    const attributes = { plan: 'free' };
    const parsed = parseEvent({ kind: 'track', eventId: 'e', name: 'page', subject: { cid: 'c' }, occurredAt: 1, attributes });
    attributes.plan = 'paid';
    expect(parsed.attributes?.plan).toBe('free');
    expect(() => parseEvent({ ...parsed, attributes: { nested: {} } })).toThrow();
  });
  it('rejects ambiguous time units, misspelled settings, and invalid observation horizons', () => {
    expect(() => settings({ minHoldMs: 0, learningHalflifeMs: 1 })).toThrow();
    expect(() => settings({ minHoldMs: 0, observationWindowMs: 0.5 })).toThrow();
    expect(() => settings({ minHoldMs: 0, observationWindowMs: 60 * 86400000 })).toThrow();
    expect(() => parseEnvelope({ siteId: 's', receivedAt: 100, event: { kind: 'track', eventId: 'e', name: 'page', occurredAt: 101, subject: { cid: 'c' } } }, 200)).toThrow();
  });
  it('isolates sites and identifier namespaces even with punctuation in IDs', () => {
    expect(subjectKey('a', { cid: 'b', uid: 'x' })).toBe(subjectKey('a', { cid: 'c', uid: 'x' }));
    expect(new Set([
      subjectKey('a', { cid: 'x' }), subjectKey('a', { cid: 'c', uid: 'x' }),
      subjectKey('a:uid', { cid: 'x' }), subjectKey('a', { cid: 'uid:x' }),
    ]).size).toBe(4);
  });
});


describe('learning correction settings', () => {
  it('defaults new experiments to seven days and validates the closure delay', () => {
    expect(settings({ minHoldMs: 0 }).correctionWindowMs).toBe(7 * 86_400_000);
    expect(settings({ minHoldMs: 0, allowedLatenessMs: 0, correctionWindowMs: 0 }).correctionWindowMs).toBe(0);
    expect(() => settings({ minHoldMs: 0, allowedLatenessMs: 100, correctionWindowMs: 99 })).toThrow();
    expect(() => settings({ minHoldMs: 0, correctionWindowMs: 61 * 86_400_000 })).toThrow();
    expect(() => settings({ minHoldMs: 0, correctionWindowMs: null })).toThrow();
  });
  it('does not silently retrofit a new deadline onto legacy assignment payloads', () => {
    const { correctionWindowMs: _deadline, ...legacy } = config;
    const old = { ...assignment('legacy'), settings: legacy };
    const event = parseEvent({ kind: 'exposure', eventId: 'legacy', occurredAt: 0, subject: { cid: 'c' }, assignment: old });
    expect(event.kind === 'exposure' && event.assignment).toEqual(old);
  });
});
