import { describe, expect, it } from 'vitest';
import { settings, subjectKey } from '../../src/core/validation.js';
import { parseEnvelope, parseEvent } from '../../src/core/events.js';
import type { Assignment } from '../../src/core/types.js';

const config = settings({ minHoldMs: 100, observationWindowMs: 1000, attributionHalfLifeMs: 100, allowedLatenessMs: 10 });
const assignment = (experimentId: string, armId = 'a'): Assignment => ({ assignmentId: `assign:${experimentId}:${armId}`, experimentId, armId, generation: 1, assignedAt: 0, policyRevision: 1, probability: 0.5, settings: config });

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


it('defaults to a finite seven-day attribution horizon', () => {
  expect(settings({ minHoldMs: 0 }).attributionWindowMs).toBe(7 * 86400000);
});
