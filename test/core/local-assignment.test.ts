import { describe, expect, it } from 'vitest';
import { exposeLocal, selectLocal } from '../../src/core/local-assignment.js';
import type { LocalPolicy, LocalSelection, LocalSelectionInput } from '../../src/core/local-assignment.js';
import { settings } from '../../src/core/validation.js';

const policy: LocalPolicy = { siteId: 'site', experimentId: 'e', generation: 1, revision: 1, sequence: 1,
  publishedAt: 0, freshUntil: 1000, usableUntil: 5000, active: true,
  arms: [{ armId: 'a', probability: 0.5 }, { armId: 'b', probability: 0.5 }],
  settings: settings({ minHoldMs: 100, observationWindowMs: 200 }), attributionWindowMs: 1000 };
let id = 0;
const options = (extra: Partial<LocalSelectionInput> = {}): LocalSelectionInput => ({
  siteId: 'site', experimentId: 'e', subject: { cid: 'browser', uid: 'user' }, now: 10, policy,
  newId: () => `assignment-${id++}`, ...extra,
});
function assigned(selection: LocalSelection) {
  expect(selection.status).toBe('assigned');
  if (selection.status !== 'assigned') throw new Error('Expected assignment');
  return selection;
}

describe('local assignment without a user coordinator', () => {
  it('falls back synchronously on cold/expired/wrong-scope policy without allocating a user', () => {
    const { policy: _policy, ...cold } = options({ newId: () => { throw new Error('Must not allocate'); } });
    expect(selectLocal(cold)).toEqual({ status: 'unavailable', refreshPolicy: true });
    expect(selectLocal(options({ now: 5000 }))).toEqual({ status: 'unavailable', refreshPolicy: true });
    expect(selectLocal(options({ siteId: 'other' })).status).toBe('unavailable');
    expect(selectLocal(options({ policy: { ...policy, publishedAt: 20 } })).status).toBe('unavailable');
  });

  it('uses a stale usable policy and requests refresh without awaiting it', () => {
    const result = assigned(selectLocal(options({ now: 1000 })));
    expect(result.refreshPolicy).toBe(true);
    expect(result.context.sample).toBeUndefined();
    expect(assigned(selectLocal(options())).refreshPolicy).toBe(false);
  });

  it('uses uid for the draw and canonical arm order, but keeps separate device contexts', () => {
    const first = assigned(selectLocal(options()));
    const other = assigned(selectLocal(options({ subject: { cid: 'other', uid: 'user' },
      policy: { ...policy, arms: [...policy.arms].reverse() } })));
    expect(other.context.assignment.armId).toBe(first.context.assignment.armId);
    expect(other.context.assignment.assignmentId).not.toBe(first.context.assignment.assignmentId);
    expect(other.context.subject.cid).toBe('other');
  });

  it('preserves old probability and settings throughout hold despite changing policy weights', () => {
    const first = assigned(selectLocal(options()));
    const changed: LocalPolicy = { ...policy, revision: 2, sequence: 2, generation: 2,
      settings: { ...policy.settings, minHoldMs: 0 }, arms: policy.arms.map(a => ({ ...a, probability: a.armId === first.context.assignment.armId ? 0.01 : 0.99 })) };
    const held = assigned(selectLocal(options({ policy: changed, previous: first.context, now: 50 })));
    expect(held.reason).toBe('held');
    expect(held.context).toBe(first.context);
    expect(held.context.assignment.probability).toBe(0.5);
    expect(held.context.assignment.policyRevision).toBe(1);
  });

  it('waits for both minimum hold and the real exposure window, then performs a new draw', () => {
    const first = assigned(selectLocal(options()));
    const shown = exposeLocal(first, 20, 'show');
    expect(shown.exposure.startAt).toBe(20);
    expect(assigned(selectLocal(options({ previous: shown.context, now: 219 }))).reason).toBe('held');
    const oldHandle = assigned(selectLocal(options({ previous: shown.context, now: 219 })));
    expect(() => exposeLocal(oldHandle, 220, 'expired-window')).toThrow();
    const next = assigned(selectLocal(options({ previous: shown.context, now: 220 })));
    expect(next.reason).toBe('selected');
    expect(next.context.drawIndex).toBe(1);
    expect(next.context.sample).toBeUndefined();
    expect(shown.context.sample?.startAt).toBe(20);
  });

  it('creates no sample before exposure, including unused assignments that expire', () => {
    const first = assigned(selectLocal(options()));
    expect(first.context.sample).toBeUndefined();
    const next = assigned(selectLocal(options({ previous: first.context, now: 110 })));
    expect(next.reason).toBe('selected');
    expect(next.context.sample).toBeUndefined();
  });

  it('keeps repeat exposures in the same sample and starts the next window only on actual exposure', () => {
    const longHold = { ...policy, settings: { ...policy.settings, minHoldMs: 1000 } };
    const first = assigned(selectLocal(options({ policy: longHold })));
    const shown = exposeLocal(first, 20, 'first');
    const held = assigned(selectLocal(options({ policy: longHold, previous: shown.context, now: 100 })));
    const repeated = exposeLocal(held, 100, 'repeat');
    expect(repeated.exposure.sampleId).toBe(shown.exposure.sampleId);
    const afterWindow = assigned(selectLocal(options({ policy: longHold, previous: repeated.context, now: 300 })));
    const later = exposeLocal(afterWindow, 300, 'later');
    expect(later.context.assignment).toBe(first.context.assignment);
    expect(later.exposure.sampleId).not.toBe(shown.exposure.sampleId);
    expect(later.exposure.startAt).toBe(300);
  });

  it('allows arm removal and login/logout/account changes to override hold without editing old samples', () => {
    const first = assigned(selectLocal(options()));
    const shown = exposeLocal(first, 20, 'show');
    const remaining = policy.arms.filter(a => a.armId !== first.context.assignment.armId).map(a => ({ ...a, probability: 1 }));
    const replacement = assigned(selectLocal(options({ previous: shown.context, now: 30, policy: { ...policy, revision: 2, arms: remaining } })));
    expect(replacement.reason).toBe('selected');
    expect(replacement.context.assignment.armId).not.toBe(first.context.assignment.armId);
    for (const subject of [{ cid: 'browser' }, { cid: 'browser', uid: 'another' }]) {
      const switched = assigned(selectLocal(options({ previous: shown.context, now: 30, subject })));
      expect(switched.reason).toBe('selected');
      expect(switched.context.drawIndex).toBe(0);
    }
    expect(shown.context.sample?.startAt).toBe(20);
  });

  it('does not expose paused experiments, missing active arms, expired handles or regressed config', () => {
    const first = assigned(selectLocal(options()));
    for (const p of [{ ...policy, active: false }, { ...policy, arms: [] }]) {
      expect(selectLocal(options({ policy: p, previous: first.context })).status).toBe('no_active_arm');
    }
    expect(() => exposeLocal(first, 5000, 'expired')).toThrow();
    expect(() => exposeLocal(first, 9, 'past')).toThrow();
    const newer = assigned(selectLocal(options({ policy: { ...policy, revision: 2 } })));
    expect(selectLocal(options({ previous: newer.context })).status).toBe('unavailable');
  });

  it('permits different held arms for the same uid on devices with different policy histories', () => {
    const left = assigned(selectLocal(options({ policy: { ...policy, arms: [{ armId: 'a', probability: 1 }] } })));
    const right = assigned(selectLocal(options({ subject: { cid: 'other', uid: 'user' },
      policy: { ...policy, sequence: 2, arms: [{ armId: 'b', probability: 1 }] } })));
    expect(assigned(selectLocal(options({ previous: left.context, now: 50 }))).context.assignment.armId).toBe('a');
    expect(assigned(selectLocal(options({ subject: right.context.subject, previous: right.context, now: 50 }))).context.assignment.armId).toBe('b');
  });

  it('allocates sequential identities according to the policy without a shared random generator', () => {
    let count = 0;
    const p = { ...policy, arms: [{ armId: 'a', probability: 0.2 }, { armId: 'b', probability: 0.8 }] };
    for (let i = 0; i < 10000; i++) {
      if (assigned(selectLocal(options({ policy: p, subject: { cid: String(i) } }))).context.assignment.armId === 'a') count++;
    }
    expect(count / 10000).toBeGreaterThan(0.18);
    expect(count / 10000).toBeLessThan(0.22);
  });
});
