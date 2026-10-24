import { describe, expect, it } from 'vitest';
import { IdentityHistory } from '../../src/core/identity-history.js';
import type { IdentityEvent, Subject } from '../../src/core/types.js';

const anon: Subject = { cid: 'browser' };
const a: Subject = { cid: 'browser', uid: 'a' };
const b: Subject = { cid: 'browser', uid: 'b' };
const event = (subject: Subject, occurredAt: number, eventId = String(occurredAt)) => ({ subject, occurredAt, eventId });
const login = (subject: Subject, at: number): IdentityEvent => ({ ...event(subject, at), kind: 'identify' });
const logout = (at: number): IdentityEvent => ({ ...event(anon, at), kind: 'logout' });

describe('raw-history identity attribution', () => {
  it('links pre-login anonymous exposure to a later authenticated goal without changing source data', () => {
    const history = new IdentityHistory([login(a, 20)]);
    const exposure = event(anon, 10);
    expect(history.matches(exposure, event(a, 30))).toBe(true);
    expect(exposure.subject).toEqual({ cid: 'browser' });
    expect(history.matches(exposure, event({ cid: 'another-device', uid: 'a' }, 30))).toBe(true);
  });

  it('never retroactively uses a login that occurred after the goal', () => {
    const history = new IdentityHistory([login(a, 20)]);
    expect(history.matches(event(anon, 10), event(a, 15))).toBe(false);
    expect(history.matches(event(anon, 10), event(anon, 15))).toBe(true);
  });

  it('does not transfer earlier anonymous ownership on direct account switches', () => {
    const history = new IdentityHistory([login(a, 20), login(b, 30)]);
    expect(history.matches(event(anon, 10), event(b, 40))).toBe(false);
    expect(history.matches(event(a, 25), event(b, 40))).toBe(false);
    expect(history.matches(event(anon, 10), event({ cid: 'device-a', uid: 'a' }, 40))).toBe(true);
  });

  it('claims only the anonymous interval following logout for the next account', () => {
    const history = new IdentityHistory([login(a, 20), logout(30), login(b, 40)]);
    expect(history.matches(event(anon, 10), event(b, 50))).toBe(false);
    expect(history.matches(event(anon, 35), event(b, 50))).toBe(true);
    expect(history.matches(event(anon, 10), event(anon, 35))).toBe(false);
    expect(history.matches(event(anon, 32), event(anon, 35))).toBe(true);
  });

  it('handles out-of-order delivery, repeated identity metadata, and stable equal-time order', () => {
    const records = [login(a, 25), login(a, 20), logout(30)];
    const history = new IdentityHistory(records);
    expect(history.matches(event(anon, 10), event(a, 28))).toBe(true);
    expect(records.map(e => e.occurredAt)).toEqual([25, 20, 30]);
    const tied = new IdentityHistory([{ ...login(a, 20), eventId: 'm' }]);
    expect(tied.matches(event(anon, 20, 'a'), event(a, 20, 'z'))).toBe(true);
    expect(tied.matches(event(anon, 20, 'a'), event(a, 20, 'b'))).toBe(false);
  });

  it('does not guess missing links, ambiguous old receipts, or another browser identity', () => {
    const history = new IdentityHistory([login(a, 20)]);
    expect(history.matches(event({ cid: 'other' }, 10), event(a, 30))).toBe(false);
    expect(history.matches(event(anon, 25), event(a, 30))).toBe(false);
    expect(history.matches(event(anon, 40), event(anon, 10))).toBe(false);
    expect(new IdentityHistory([]).matches(event(anon, 10), event(a, 30))).toBe(false);
    expect(new IdentityHistory([]).matches(event(anon, 10), event(anon, 30))).toBe(true);
  });
});
