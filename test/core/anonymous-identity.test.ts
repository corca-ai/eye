import { expect, it } from 'vitest';
import { IdentityHistory } from '../../src/core/identity-history.js';
import { parseEvent } from '../../src/core/events.js';

it('an anonymous-state check preserves anonymous exposure, but logout deliberately ends it', () => {
  const at = (eventId: string, occurredAt: number, uid?: string) => ({eventId, occurredAt, subject: {cid: 'browser', ...(uid ? {uid} : {})}});
  const exposure = at('shown', 10), goal = at('goal', 40, 'account');
  const initial = parseEvent({...at('initial', 20), kind: 'anonymous'});
  const login = parseEvent({...at('login', 30, 'account'), kind: 'identify'});
  if (initial.kind !== 'anonymous' || login.kind !== 'identify') throw new Error('Identity parser');
  expect(new IdentityHistory([initial, login]).matches(exposure, goal)).toBe(true);
  expect(new IdentityHistory([{...at('logout', 20), kind: 'logout'}, login]).matches(exposure, goal)).toBe(false);
  const previousLogin = {...at('previous', 5, 'another'), kind: 'identify' as const};
  expect(new IdentityHistory([previousLogin, initial, login]).matches(exposure, goal)).toBe(false);
  expect(() => parseEvent({...at('invalid', 20, 'account'), kind: 'anonymous'})).toThrow();
});
