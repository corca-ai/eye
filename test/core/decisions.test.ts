import { afterEach, expect, it, vi } from 'vitest';
import { DecisionCache, decisionRuntime } from '../../src/decisions.js';
import { settings } from '../../src/core/validation.js';
import type { PreparedDecision, PublishedPolicy } from '../../src/transport.js';
const now = 1_800_000_000_000, secret = 'test-secret-with-at-least-32-bytes-long';
afterEach(() => vi.restoreAllMocks());
function fixture() {
  let clock = now;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const policy: PublishedPolicy = { experimentId: 'exp', generation: 1, revision: 1, statsAsOf: now,
    asOf: now, scoreScale: 1, arms: [], publishedAt: now, sequence: 1, status: 'active', activeArms: ['a'] };
  const prepared: PreparedDecision = { reuseUntil: now + 300_000, policy, decision: {
    status: 'assigned', reason: 'selected', routingKey: '["site","cid","c"]', assignment: {
      assignmentId: 'assignment', experimentId: 'exp', armId: 'a', generation: 1, policyRevision: 1,
      probability: 1, assignedAt: now, settings: settings({ minHoldMs: 0 }),
    },
  } };
  const service = { getPublishedPolicy: vi.fn(async () => policy), prepareDecision: vi.fn(async () => prepared) };
  const pending: Promise<unknown>[] = [], ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
  const cache = new DecisionCache(), onDecision = vi.fn();
  return { policy, service, cache, onDecision, pending, ctx, advance: (ms: number) => { clock += ms; } };
}
it('returns cold nonparticipation without waiting for an unresolved policy request', async () => {
  const f = fixture();
  let release!: (policy: PublishedPolicy) => void;
  f.service.getPublishedPolicy.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const runtime = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache, onDecision: f.onDecision }, () => {});
  expect(await runtime.decide({ cid: 'c' }, 'exp')).toEqual({ status: 'unavailable', experimentId: 'exp' });
  expect(f.service.prepareDecision).not.toHaveBeenCalled();
  expect(f.onDecision).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'skipped', reason: 'cold' }));
  release(f.policy); await Promise.all(f.pending);
});
it('reuses signed state with zero RPCs while fresh, refreshes stale state, and never extends an old publication', async () => {
  const f = fixture(), runtime = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache }, () => {});
  const prepared = await runtime.prepare({ cid: 'c' }, 'exp');
  expect(prepared.token).toBeTruthy();
  f.service.prepareDecision.mockClear();
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('assigned');
  expect(f.service.getPublishedPolicy).not.toHaveBeenCalled(); expect(f.service.prepareDecision).not.toHaveBeenCalled();
  f.advance(60_001);
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('assigned');
  await Promise.all(f.pending);
  expect(f.service.getPublishedPolicy).toHaveBeenCalledTimes(1);
  f.advance(240_000);
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('unavailable');
});
it('rejects tampering, another uid, and a locally known stopped arm', async () => {
  const f = fixture(), options = { secret, cache: f.cache };
  const token = (await decisionRuntime(f.service, f.ctx, 'site', options, () => {}).prepare({ cid: 'c', uid: 'alice' }, 'exp')).token!;
  const runtime = decisionRuntime(f.service, f.ctx, 'site', { ...options, tokens: { exp: token } }, () => {});
  expect((await runtime.decide({ cid: 'other-device', uid: 'alice' }, 'exp')).status).toBe('assigned');
  expect((await runtime.decide({ cid: 'c', uid: 'bob' }, 'exp')).status).toBe('unavailable');
  const tampered = decisionRuntime(f.service, f.ctx, 'site', { ...options, tokens: { exp: token.slice(0, -4) + 'AAAA' } }, () => {});
  expect((await tampered.decide({ cid: 'c', uid: 'alice' }, 'exp')).status).toBe('unavailable');
  f.cache.put(JSON.stringify(['site', 'exp']), { ...f.policy, sequence: 2, activeArms: [], status: 'paused' });
  expect((await runtime.decide({ cid: 'c', uid: 'alice' }, 'exp')).status).toBe('no_active_arm');
});
