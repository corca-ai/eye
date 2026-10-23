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

it('renews a nearly expired lease in the background without skipping or waiting', async () => {
  const f=fixture(),onPrepared=vi.fn();
  const runtime=decisionRuntime(f.service,f.ctx,'site',{secret,cache:f.cache,onPrepared},()=>{});
  const first=await runtime.prepare({cid:'c'},'exp');
  f.service.prepareDecision.mockClear();
  let resolve!:(value:PreparedDecision)=>void;
  f.service.prepareDecision.mockImplementation(()=>new Promise(r=>{resolve=r;}));
  f.advance(240_001);
  expect((await runtime.decide({cid:'c'},'exp')).status).toBe('assigned');
  expect(f.service.prepareDecision).toHaveBeenCalledTimes(1);
  expect(onPrepared).not.toHaveBeenCalled();
  expect(f.service.getPublishedPolicy).not.toHaveBeenCalled();
  resolve({decision:first.decision,reuseUntil:now+600_000,policy:{...f.policy,publishedAt:now+240_001,sequence:2}});
  await Promise.all(f.pending);
  expect(onPrepared).toHaveBeenCalledTimes(1);
  f.advance(30_000);
  expect((await runtime.decide({cid:'c'},'exp')).status).toBe('assigned');
  expect(f.service.prepareDecision).toHaveBeenCalledTimes(1);
});

it('does not repeatedly prepare a lease whose confirmed observation cannot be extended', async () => {
  const f=fixture(),onPrepared=vi.fn();
  const runtime=decisionRuntime(f.service,f.ctx,'site',{secret,cache:f.cache,onPrepared},()=>{});
  await runtime.prepare({cid:'c'},'exp');f.service.prepareDecision.mockClear();
  f.advance(240_001);
  expect((await runtime.decide({cid:'c'},'exp')).status).toBe('assigned');await Promise.all(f.pending);
  expect(f.service.prepareDecision).toHaveBeenCalledTimes(1);
  f.advance(10_000);
  expect((await runtime.decide({cid:'c'},'exp')).status).toBe('assigned');
  expect(f.service.prepareDecision).toHaveBeenCalledTimes(1);
});

it('uses preparation to refresh a cold policy without a duplicate policy RPC', async () => {
  const f = fixture(), onPrepared = vi.fn();
  let resolve!: (value: PreparedDecision) => void;
  const prepared = await f.service.prepareDecision();
  f.service.prepareDecision.mockClear();
  f.service.prepareDecision.mockImplementation(() => new Promise(r => { resolve = r; }));
  const runtime = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache, onPrepared }, () => {});
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('unavailable');
  expect(f.service.prepareDecision).toHaveBeenCalledTimes(1);
  expect(f.service.getPublishedPolicy).not.toHaveBeenCalled();
  resolve(prepared); await Promise.all(f.pending);
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('assigned');
});

it('warms policy independently for existing tokens while preparation is blocked', async () => {
  const f = fixture();
  const prepared = await decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache }, () => {}).prepare({ cid: 'c' }, 'exp');
  const cache = new DecisionCache();
  let release!: (prepared: PreparedDecision) => void;
  f.service.prepareDecision.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const options = { secret, cache, tokens: { exp: prepared.token! }, onPrepared: vi.fn() };
  const first = decisionRuntime(f.service, f.ctx, 'site', options, () => {});
  try {
    expect((await first.decide({ cid: 'c' }, 'exp')).status).toBe('unavailable');
    expect(f.service.getPublishedPolicy).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    const next = decisionRuntime(f.service, f.ctx, 'site', options, () => {});
    expect((await next.decide({ cid: 'c' }, 'exp')).status).toBe('assigned');
  } finally { release(prepared); await Promise.all(f.pending); }
});

it('falls back to policy refresh if cold preparation fails', async () => {
  const f = fixture(), report = vi.fn();
  f.service.prepareDecision.mockRejectedValue(new Error('subject unavailable'));
  const runtime = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache, onPrepared: vi.fn() }, report);
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('unavailable');
  for (let i = 0; i < f.pending.length; i++) await f.pending[i];
  expect(f.service.getPublishedPolicy).toHaveBeenCalledTimes(1);
  expect(f.cache.read(JSON.stringify(['site', 'exp']))).toEqual(f.policy);
  expect(report).toHaveBeenCalledTimes(1);
});

it('renews a fifteen-minute token at twelve minutes while retaining independent policy freshness', async () => {
  const f = fixture();
  const prepared = await f.service.prepareDecision();
  f.service.prepareDecision.mockResolvedValue({ ...prepared, reuseUntil: now + 900_000 });
  const runtime = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache, onPrepared: vi.fn() }, () => {});
  const state = await runtime.prepare({ cid: 'c' }, 'exp');
  f.service.prepareDecision.mockClear();
  f.advance(719_999);
  // With no policy refresh, a valid long token still cannot use an expired policy.
  const withoutPreparation = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache, tokens: { exp: state.token! } }, () => {});
  expect((await withoutPreparation.decide({ cid: 'c' }, 'exp')).status).toBe('unavailable');
  await Promise.all(f.pending);
  f.cache.put(JSON.stringify(['site', 'exp']), { ...f.policy, sequence: 2, publishedAt: now + 719_999 });
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('assigned');
  expect(f.service.prepareDecision).not.toHaveBeenCalled();
  f.advance(2);
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('assigned');
  expect(f.service.prepareDecision).toHaveBeenCalledTimes(1);
  await Promise.all(f.pending);
});

it('gives a short observation a proportional renewal margin instead of renewing immediately', async () => {
  const f = fixture(), prepared = await f.service.prepareDecision();
  f.service.prepareDecision.mockResolvedValue({ ...prepared, reuseUntil: now + 10_000 });
  const runtime = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache, onPrepared: vi.fn() }, () => {});
  await runtime.prepare({ cid: 'c' }, 'exp');
  f.service.prepareDecision.mockClear();
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('assigned');
  f.advance(7999);
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('assigned');
  expect(f.service.prepareDecision).not.toHaveBeenCalled();
  f.advance(1);
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('assigned');
  expect(f.service.prepareDecision).toHaveBeenCalledTimes(1);
  await Promise.all(f.pending);
});
