import { exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { createEye } from '../../src/client.js';
import { createEyeRequest } from '../../src/request.js';
import { DecisionCache } from '../../src/decisions.js';
import type { EventEnvelope } from '../../src/core/types.js';

async function fixture() {
  const ctx = createExecutionContext(), siteId = crypto.randomUUID();
  const subject = { cid: 'browser', uid: 'alice' };
  const decisions = { secret: 'request-test-secret-at-least-32-bytes', cache: new DecisionCache() };
  const admin = createEye({ ctx, siteId, service: exports.default, decisions });
  await admin.experiments.create({ experimentId: 'checkout', arms: ['compact'], settings: { minHoldMs: 0 } });
  const prepared = await admin.prepare({ subject, experimentId: 'checkout' });
  if (!prepared.token) throw new Error('Expected token');
  const events: EventEnvelope[] = [];
  const ingest = vi.fn(async (batch: readonly EventEnvelope[]) => { events.push(...batch); });
  // Capture only SDK delivery; policy, assignment and signing use the real Worker.
  const service = new Proxy(exports.default, { get(target, property) {
    return property === 'ingest' ? ingest : Reflect.get(target, property);
  } });
  const onError = vi.fn();
  return { ctx, subject, events, ingest, onError, options: {
    ctx, siteId, service, subject, onError, decisions: { ...decisions, tokens: { checkout: prepared.token } },
  } };
}
const checkout = { experimentId: 'checkout', variants: { compact: 'small' }, fallback: 'normal' };

it('binds identity, selects a value without exposure and reports exactly one explicit exposure', async () => {
  const f = await fixture();
  const eye = createEyeRequest({ ...f.options, userAttributes: { locale: 'ko' } });
  f.subject.uid = 'bob'; // A later auth mutation cannot change this request's identity.
  const selected = await eye.variant(checkout);
  expect(selected).toMatchObject({ value: 'small', armId: 'compact' });
  expect(f.ingest).not.toHaveBeenCalled();
  const first = selected.expose({ eventId: 'visible' });
  expect(selected.expose({ eventId: 'duplicate-call' })).toBe(first);
  eye.goal({ goalId: 'purchase', value: 12, eventId: 'order-1' });
  await waitOnExecutionContext(f.ctx);
  expect(f.events).toHaveLength(2);
  expect(f.events[0]!.event).toMatchObject({ kind: 'exposure', eventId: 'visible', subject: { uid: 'alice' }, userAttributes: { locale: 'ko' } });
  expect(f.events[1]!.event).toMatchObject({ kind: 'goal', subject: { uid: 'alice' } });
});

it('unknown arms and disabled experiments fall back without fabricated exposure', async () => {
  const f = await fixture();
  const unknown = await createEyeRequest(f.options).variant({ ...checkout, variants: { standard: 'normal' } });
  expect(unknown.armId).toBeNull(); expect(unknown.expose()).toBeNull();
  expect(f.onError).toHaveBeenCalledTimes(1);
  const disabled = createEyeRequest({ ...f.options, experimentsEnabled: false });
  const selected = await disabled.variant(checkout);
  expect(selected.value).toBe('normal'); expect(selected.expose()).toBeNull();
  disabled.track({ name: 'page_view' });
  await waitOnExecutionContext(f.ctx);
  expect(f.events.map(e => e.event.kind)).toEqual(['track']);
});

it('initialization and invalid-input errors cannot break fallback, even with a throwing reporter', async () => {
  const f = await fixture();
  const report = vi.fn(() => { throw new Error('logging offline'); });
  const broken = createEyeRequest({ ...f.options, siteId: '', onError: report });
  expect((await broken.variant(checkout)).expose()).toBeNull();
  expect(broken.track({ name: 'page_view' }).accepted).toBe(false);
  const eye = createEyeRequest({ ...f.options, onError: report });
  expect(eye.goal({ goalId: 'purchase', value: NaN }).accepted).toBe(false);
  expect(report).toHaveBeenCalled();
  await waitOnExecutionContext(f.ctx);
  expect(f.events).toHaveLength(0);
});

it('reports asynchronous delivery failures through the same hook as local rejection', async () => {
  const f = await fixture();
  f.ingest.mockRejectedValueOnce(new Error('delivery offline'));
  const eye = createEyeRequest(f.options);
  expect(eye.track({ name: 'page_view' }).accepted).toBe(true);
  await waitOnExecutionContext(f.ctx);
  expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'delivery offline' }));
});

it('session token writes merge and stale authentication epochs cannot repopulate cleared tokens', async () => {
  const { env } = await import('cloudflare:workers');
  const { runInDurableObject } = await import('cloudflare:test');
  const { EyeSession, eyeSessionAdapter } = await import('../../examples/session.js');
  await runInDurableObject(env.EXPERIMENTS.getByName(crypto.randomUUID()), async (_instance, state) => {
    const session = new EyeSession(state, env);
    const first = session.snapshot();
    const adapter = eyeSessionAdapter(first, async (epoch, id, token) => session.setToken(epoch, id, token));
    await Promise.all([adapter.setDecisionToken('checkout', 'one'), adapter.setDecisionToken('hero', 'two')]);
    expect(session.snapshot().tokens).toEqual({ checkout: 'one', hero: 'two' });
    session.reset();
    await adapter.setDecisionToken('checkout', 'late');
    expect(session.snapshot().tokens).toEqual({});
  });
});

it('cookie preparation is separate from rendering and old auth scopes cannot supply the next scope token', async () => {
  const { cookieCheckout } = await import('../../examples/cookie-host.js');
  const f = await fixture();
  const admin = createEye({ ...f.options, siteId: 'shop' });
  await admin.experiments.create({ experimentId: 'checkout', arms: ['compact'], settings: { minHoldMs: 0 } });
  const env = { EYE: f.options.service, EYE_DECISION_SECRET: f.options.decisions.secret };
  const page = new Request('https://shop.example/checkout', { headers: { Cookie: 'cid=browser' } });
  const first = await cookieCheckout(page, env, f.ctx, 'login-a', 'alice');
  expect(await first.text()).toContain('Standard checkout');
  const denied = await cookieCheckout(new Request('https://shop.example/eye/prepare-checkout', { method: 'POST' }), env, f.ctx, 'login-a', 'alice');
  expect(denied.status).toBe(403);
  const preparation = await cookieCheckout(new Request('https://shop.example/eye/prepare-checkout', {
    method: 'POST', headers: { Origin: 'https://shop.example', Cookie: 'cid=browser' },
  }), env, f.ctx, 'login-a', 'alice');
  expect(preparation.status).toBe(200);
  const timing = await preparation.json<{ retryAfterMs: number }>();
  expect(timing.retryAfterMs).toBeGreaterThanOrEqual(1000);
  expect(timing.retryAfterMs).toBeLessThanOrEqual(240_000);
  const cookies = preparation.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const next = new Request(page.url, { headers: { Cookie: `cid=browser; ${cookies}` } });
  const ready = await cookieCheckout(next, env, f.ctx, 'login-a', 'alice');
  expect(await ready.text()).toContain('Compact checkout');
  expect(ready.headers.get('Cache-Control')).toBe('private, no-store');
  const switched = await cookieCheckout(next, env, f.ctx, 'login-b', 'alice');
  expect(await switched.text()).toContain('Compact checkout'); // warm policy permits a fresh local assignment for the new auth scope
  await waitOnExecutionContext(f.ctx);
  expect(f.events.filter(e => e.event.kind === 'exposure')).toHaveLength(2);
});
