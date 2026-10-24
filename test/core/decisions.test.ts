import { afterEach, expect, it, vi } from 'vitest';
import { DecisionCache, decisionRuntime } from '../../src/decisions.js';
import { settings } from '../../src/core/validation.js';
import type { PublishedPolicy } from '../../src/transport.js';
const now = 1_800_000_000_000, secret = 'test-secret-with-at-least-32-bytes-long';
afterEach(() => vi.restoreAllMocks());
function fixture() {
  let clock = now;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const policy: PublishedPolicy = { experimentId: 'exp', generation: 1, revision: 1, statsAsOf: now,
    settings: settings({ minHoldMs: 100000 }), asOf: now, scoreScale: 1,
    arms: [{ armId: 'a', weight: 0, meanReward: 0, score: 1, probability: 1 }],
    publishedAt: now, sequence: 1, status: 'active', activeArms: ['a'] };
  const service = { getPublishedPolicy: vi.fn(async (_site: string, _experimentId: string) => policy) };
  const pending: Promise<unknown>[] = [], ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
  const cache = new DecisionCache();
  return { policy, service, cache, pending, ctx, advance: (ms: number) => { clock += ms; } };
}
it('cold requests skip without waiting for unresolved network I/O; warm requests select without RPC', async () => {
  const f = fixture(); let release!: (policy: PublishedPolicy) => void;
  f.service.getPublishedPolicy.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const runtime = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache }, () => {});
  expect(await runtime.decide({ cid: 'c' }, 'exp')).toEqual({ status: 'unavailable', experimentId: 'exp' });
  release(f.policy); await Promise.all(f.pending); f.service.getPublishedPolicy.mockClear();
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('assigned');
  expect(f.service.getPublishedPolicy).not.toHaveBeenCalled(); await runtime.state();
});
it('persists the first real exposure and restores hold and original probability in a new request', async () => {
  const f = fixture(), options = { secret, cache: f.cache };
  const runtime = decisionRuntime(f.service, f.ctx, 'site', options, () => {});
  const prepared = await runtime.prepare({ cid: 'c', uid: 'u' }, 'exp');
  if (prepared.decision.status !== 'assigned') throw new Error('expected arm');
  f.advance(100);
  const exposure = runtime.expose(prepared.decision, now + 100, 'visible');
  const tokens = await runtime.state();
  const restored = decisionRuntime(f.service, f.ctx, 'site', { ...options, tokens }, () => {});
  const decision = await restored.decide({ cid: 'c', uid: 'u' }, 'exp');
  expect(decision).toMatchObject({ status: 'assigned', reason: 'held', localContext: { sample: { startAt: exposure.startAt, sampleId: exposure.sampleId } } });
  expect(f.service.getPublishedPolicy).toHaveBeenCalledTimes(1);
});
it('auth switches and invalid signatures cannot reuse the prior context', async () => {
  const f = fixture(), options = { secret, cache: f.cache };
  const runtime = decisionRuntime(f.service, f.ctx, 'site', options, () => {});
  const initial = await runtime.prepare({ cid: 'c', uid: 'alice' }, 'exp');
  const error = vi.fn();
  for (const token of [initial.token!, initial.token! + 'tamper']) {
    const next = decisionRuntime(f.service, f.ctx, 'site', { ...options, tokens: { exp: token } }, error);
    const decision = await next.decide({ cid: 'c', uid: 'bob' }, 'exp');
    expect(decision).toMatchObject({ status: 'assigned', reason: 'selected', localContext: { subject: { uid: 'bob' } } });
    await next.state();
  }
  expect(error).toHaveBeenCalled();
});
it('stale policies refresh in background and expired policies skip even with a valid held context', async () => {
  const f = fixture(), runtime = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache, freshMs: 60_000, maxAgeMs: 300_000 }, () => {});
  await runtime.prepare({ cid: 'c' }, 'exp'); f.advance(60_001);
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('assigned');
  await Promise.all(f.pending); f.advance(240_000);
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('unavailable');
  await Promise.all(f.pending);
});

it('signs and returns current state while ordered host persistence is still blocked', async () => {
  const f = fixture(); let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const saved: string[] = [];
  const onPrepared = vi.fn(async (_id: string, token: string) => { await blocked; saved.push(token); });
  const runtime = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache, onPrepared }, () => {});
  let result: Record<string, string> | undefined;
  const local = (async () => {
    const prepared = await runtime.prepare({ cid: 'c' }, 'exp');
    if (prepared.decision.status !== 'assigned') throw new Error('expected arm');
    runtime.expose(prepared.decision, now, 'visible');
    result = await runtime.state();
  })();
  try {
    await vi.waitFor(() => expect(result?.exp).toEqual(expect.any(String)));
    expect(saved).toEqual([]);
  } finally { release(); await local; await Promise.all(f.pending); }
  expect(saved).toHaveLength(2); expect(saved[1]).toBe(result!.exp);
  expect(saved[0]).not.toBe(saved[1]);
});
it('rechecking an unchanged policy avoids repeated RPCs but never extends its hard expiry', async () => {
  const f = fixture(), runtime = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache }, () => {});
  await runtime.prepare({ cid: 'c' }, 'exp');
  f.advance(15 * 60_000 + 1);
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('assigned');
  await Promise.all(f.pending);
  expect(f.service.getPublishedPolicy).toHaveBeenCalledTimes(2);
  f.advance(60_000);
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('assigned');
  expect(f.service.getPublishedPolicy).toHaveBeenCalledTimes(2);
  f.advance(6 * 3_600_000);
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('unavailable');
  await Promise.all(f.pending);
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('unavailable');
});
it('accepts a legacy maxAge-only configuration and refreshes before its explicit hard deadline', async () => {
  const f = fixture(), runtime = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache, maxAgeMs: 300_000 }, () => {});
  await runtime.prepare({ cid: 'c' }, 'exp');
  f.advance(150_001);
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('assigned');
  await Promise.all(f.pending);
  expect(f.service.getPublishedPolicy).toHaveBeenCalledTimes(2);
  f.advance(150_000);
  expect((await runtime.decide({ cid: 'c' }, 'exp')).status).toBe('unavailable');
  await Promise.all(f.pending);
  expect(() => decisionRuntime(f.service, f.ctx, 'site', { secret, freshMs: 300_001, maxAgeMs: 300_000 }, () => {})).toThrow();
});

it('explicit preparation never selects a policy older than one already cached', async () => {
  const f = fixture();
  let release!: (policy: PublishedPolicy) => void;
  f.service.getPublishedPolicy.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const oldRuntime = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache }, () => {});
  const slow = oldRuntime.prepare({ cid: 'old-request' }, 'exp');
  const newer: PublishedPolicy = { ...f.policy, sequence: 2, revision: 2, status: 'paused', arms: [], activeArms: [] };
  f.service.getPublishedPolicy.mockResolvedValueOnce(newer);
  const freshRuntime = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache }, () => {});
  expect((await freshRuntime.prepare({ cid: 'new-request' }, 'exp')).decision.status).toBe('no_active_arm');
  release(f.policy);
  expect((await slow).decision.status).toBe('no_active_arm');
  await Promise.all(f.pending);
});

it('state preserves other experiments across requests that select only one experiment or only collect events', async () => {
  const f = fixture();
  f.service.getPublishedPolicy.mockImplementation(async (_site, experimentId) => ({ ...f.policy, experimentId }));
  const first = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache }, () => {});
  await first.prepare({ cid: 'c' }, 'exp');
  await first.prepare({ cid: 'c' }, 'other');
  const tokens = await first.state();
  const second = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache, tokens }, () => {});
  await second.decide({ cid: 'c' }, 'exp');
  expect(await second.state()).toEqual(tokens);
  const collectionOnly = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache, tokens }, () => {});
  expect(await collectionOnly.state()).toEqual(tokens);
  await Promise.all(f.pending);
});

it('state drops invalid untouched tokens and preserves a newly exposed sample', async () => {
  const f = fixture(), errors: unknown[] = [];
  const first = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache }, () => {});
  const prepared = await first.prepare({ cid: 'c' }, 'exp');
  if (prepared.decision.status !== 'assigned') throw new Error('expected assignment');
  const tokens: Record<string, string> = { ...await first.state(), invalid: 'bad.signature' };
  const second = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache, tokens }, error => errors.push(error));
  second.expose(prepared.decision, now, 'visible');
  const next = await second.state();
  expect(next.invalid).toBeUndefined();
  expect(next.exp).not.toBe(tokens.exp);
  const third = decisionRuntime(f.service, f.ctx, 'site', { secret, cache: f.cache, tokens: next }, () => {});
  const decision = await third.decide({ cid: 'c' }, 'exp');
  expect(decision.status === 'assigned' && decision.localContext?.sample?.startAt).toBe(now);
  expect(errors).toHaveLength(1);
  await Promise.all(f.pending);
});
