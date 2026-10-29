import { exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { createEye } from '../../src/client.js';
import { createEyeBrowserServer } from '../../src/browser-server.js';
import type { EventEnvelope } from '../../src/core/types.js';
const secret = 'browser-server-test-secret-with-32-bytes';
async function fixture(observationWindowMs = 7 * 86400000) {
  const ctx = createExecutionContext(), events: EventEnvelope[] = [];
  const ingest = vi.fn(async (batch: readonly EventEnvelope[]) => { events.push(...batch.map(item => ({ ...item }))); });
  const service = new Proxy(exports.default, { get(target, property) { return property === 'ingest' ? ingest : Reflect.get(target, property); } });
  const options = { ctx, service, subject: { cid: 'browser', uid: 'alice' }, browserBinding: 'trusted-browser', scope: 'login-a',
    receiptSecret: secret, decisions: { secret }, onError: vi.fn() };
  await createEye(options).experiments.create({ experimentId: 'checkout', arms: ['compact'], settings: { minHoldMs: 0, observationWindowMs } });
  const snapshot = await createEyeBrowserServer(options).prepare(['checkout']);
  expect(snapshot.choices).toHaveLength(1);
  const choice = snapshot.choices[0]!;
  return { options, events, ingest, snapshot, choice, event: { eventId: 'exposure', receipt: choice.receipt, occurredAt: snapshot.serverNow } };
}
it('receives encrypted original assignment and identity after logout without preparing a new assignment', async () => {
  const f = await fixture();
  expect(f.choice.receipt).not.toContain('alice');
  const receiver = createEyeBrowserServer({ ...f.options, subject: { cid: 'browser', uid: 'bob' }, scope: 'login-b' });
  expect(await receiver.receive([f.event])).toEqual([{ eventId: 'exposure', accepted: true }]);
  expect(f.events[0]!.event).toMatchObject({ kind: 'exposure', subject: { cid: 'browser', uid: 'alice' }, assignment: { armId: 'compact' } });
  await waitOnExecutionContext(f.options.ctx);
});
it('rejects changed receipt, wrong browser/site, and display outside its lease', async () => {
  const f = await fixture();
  const receiver = createEyeBrowserServer(f.options);
  const tampered = { ...f.event, receipt: `x${f.event.receipt}` };
  expect((await receiver.receive([tampered]))[0]!.accepted).toBe(false);
  expect((await createEyeBrowserServer({ ...f.options, browserBinding: 'other' }).receive([f.event]))[0]!.accepted).toBe(false);
  expect((await createEyeBrowserServer({ ...f.options, service: new Proxy(f.options.service, { get(target, property) { return property === 'getInstallationId' ? async () => 'another-installation' : Reflect.get(target, property); } }) }).receive([f.event]))[0]!.accepted).toBe(false);
  expect((await receiver.receive([{ ...f.event, occurredAt: f.choice.applyUntil }]))[0]!.accepted).toBe(false);
  expect(f.events).toHaveLength(0); await waitOnExecutionContext(f.options.ctx);
});
it('does not acknowledge delivery until Queue ingestion succeeds', async () => {
  const f = await fixture(); f.ingest.mockRejectedValueOnce(new Error('Queue offline'));
  await expect(createEyeBrowserServer(f.options).receive([f.event])).rejects.toThrow('Queue offline');
  await waitOnExecutionContext(f.options.ctx);
});
it('accepts delivery within 15 seconds and drops older displays', async () => {
  const f = await fixture(), receiver = createEyeBrowserServer(f.options);
  const clock = vi.spyOn(Date, 'now');
  try {
    clock.mockReturnValue(f.event.occurredAt + 15_000);
    expect((await receiver.receive([f.event]))[0]!.accepted).toBe(true);
    clock.mockReturnValue(f.event.occurredAt + 15_001);
    expect((await receiver.receive([{ ...f.event, eventId: 'too-late' }]))[0]!.accepted).toBe(false);
  } finally { clock.mockRestore(); }
  await waitOnExecutionContext(f.options.ctx);
});

it('does not acknowledge an early failed ingestion in a multi-event batch', async () => {
  const f = await fixture();
  f.ingest.mockRejectedValueOnce(new Error('first delivery failed'));
  await expect(createEyeBrowserServer(f.options).receive([f.event, { ...f.event, eventId: 'second' }])).rejects.toThrow('first delivery failed');
  expect(f.ingest.mock.calls[0]![0]).toHaveLength(2);
  await waitOnExecutionContext(f.options.ctx);
});
it('small future skew retries without rewriting canonical occurrence time', async () => {
  const f = await fixture(), receiver = createEyeBrowserServer(f.options);
  const event = { ...f.event, occurredAt: f.snapshot.serverNow + 100 };
  const clock = vi.spyOn(Date, 'now');
  try {
    clock.mockReturnValue(event.occurredAt - 1);
    await expect(receiver.receive([event])).rejects.toThrow('retry unchanged');
    expect(f.ingest).not.toHaveBeenCalled();
    clock.mockReturnValue(event.occurredAt + 1);
    expect((await receiver.receive([event]))[0]!.accepted).toBe(true);
    clock.mockReturnValue(event.occurredAt + 2);
    expect((await receiver.receive([event]))[0]!.accepted).toBe(true);
    expect(f.events.map(e => e.event.occurredAt)).toEqual([event.occurredAt, event.occurredAt]);
  } finally { clock.mockRestore(); }
  await waitOnExecutionContext(f.options.ctx);
});

it('preserves browser sample IDs across a window boundary, replay and subsequent requests', async () => {
  const f = await fixture(1000), start = f.snapshot.serverNow;
  const first = { ...f.event, eventId: 'first', sample: { sampleId: 'browser-a', startAt: start } };
  const second = { ...f.event, eventId: 'second', occurredAt: start + 1100, sample: { sampleId: 'browser-b', startAt: start + 1100 } };
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start + 1500);
  try {
    expect(await createEyeBrowserServer(f.options).receive([first, second])).toEqual([
      { eventId: 'first', accepted: true }, { eventId: 'second', accepted: true },
    ]);
    await createEyeBrowserServer(f.options).receive([second, { ...second, eventId: 'third', occurredAt: start + 1200 }]);
    const exposures = f.events.map(e => e.event);
    expect(exposures.map(e => e.kind === 'exposure' && e.sample?.sampleId)).toEqual(['browser-a', 'browser-b', 'browser-b', 'browser-b']);
    expect(exposures[1]).toEqual(exposures[2]);
  } finally { clock.mockRestore(); }
  await waitOnExecutionContext(f.options.ctx);
});
it('supports maxAge-only hosts and gives CSR the same shortened refresh interval', async () => {
  const f = await fixture(), before = Date.now();
  const snapshot = await createEyeBrowserServer({ ...f.options, decisions: { secret, maxAgeMs: 300_000 } }).prepare(['checkout']);
  const choice = snapshot.choices[0]!;
  expect(choice.refreshAfter).toBeGreaterThanOrEqual(before + 150_000);
  expect(choice.refreshAfter).toBeLessThanOrEqual(snapshot.serverNow + 150_000);
  expect(choice.refreshAfter).toBeLessThan(choice.applyUntil);
  await waitOnExecutionContext(f.options.ctx);
});

it('rejects non-finite user attributes before JSON can silently turn them into null', async () => {
  const f = await fixture();
  expect(() => createEyeBrowserServer({ ...f.options, userAttributes: { revenue: NaN } })).toThrow();
  expect(() => createEyeBrowserServer({ ...f.options, userAttributes: { revenue: Infinity } })).toThrow();
  await waitOnExecutionContext(f.options.ctx);
});

it('checks configured attribute limits before issuing receipts and honors overrides', async () => {
  const f = await fixture(), userAttributes = { a: 1, b: 2, c: 3 };
  expect(() => createEyeBrowserServer({ ...f.options, userAttributes, collectionLimits: { maxAttributeKeys: 2 } })).toThrow('Too many attribute keys');
  const server = createEyeBrowserServer({ ...f.options, userAttributes, collectionLimits: { maxAttributeKeys: 3 } });
  const snapshot = await server.prepare(['checkout']);
  expect(snapshot.choices).toHaveLength(1);
  expect(await server.receive([{ eventId: 'bounded-attributes', receipt: snapshot.choices[0]!.receipt, occurredAt: snapshot.serverNow }]))
    .toEqual([{ eventId: 'bounded-attributes', accepted: true }]);
  expect(f.events[0]!.event).toMatchObject({ userAttributes });
  await waitOnExecutionContext(f.options.ctx);
});

it('does not publish a receipt that its own receiver rejects for size', async () => {
  const f = await fixture();
  const server = createEyeBrowserServer({ ...f.options, userAttributes: { segment: 'x'.repeat(20000) } });
  const prepared = await server.prepare(['checkout']);
  expect(prepared.choices).toEqual([]);
  expect(f.options.onError).toHaveBeenCalled();
  await waitOnExecutionContext(f.options.ctx);
});

it('omits choices that expire while later experiments are being prepared', async () => {
  const start = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  try {
    const f = await fixture();
    await createEye(f.options).experiments.create({ experimentId: 'later', arms: ['compact'], settings: { minHoldMs: 0 } });
    const service = new Proxy(f.options.service, { get(target, property) {
      if (property !== 'getPublishedPolicy') return Reflect.get(target, property);
      return async (experimentId: string, maxAgeMs?: number) => {
        if (experimentId === 'later') clock.mockReturnValue(start + 1000);
        return target.getPublishedPolicy(experimentId, maxAgeMs);
      };
    } });
    const server = createEyeBrowserServer({ ...f.options, service, decisions: { secret, maxAgeMs: 1000 } });
    const prepared = await server.prepare(['checkout', 'later']);
    expect(prepared.serverNow).toBe(start + 1000);
    expect(prepared.choices.map(choice => choice.experimentId)).toEqual(['later']);
    expect(await server.receive([{ eventId: 'still-usable', receipt: prepared.choices[0]!.receipt, occurredAt: prepared.serverNow }]))
      .toEqual([{ eventId: 'still-usable', accepted: true }]);
    await waitOnExecutionContext(f.options.ctx);
  } finally { clock.mockRestore(); }
});

it('rejects a non-array preparation batch instead of iterating a string as experiment IDs', async () => {
  const f = await fixture();
  // @ts-expect-error Exercise unvalidated JSON at the public boundary.
  await expect(createEyeBrowserServer(f.options).prepare('checkout')).rejects.toMatchObject({ code: 'invalid_input' });
  await waitOnExecutionContext(f.options.ctx);
});

it('receives large valid attribute receipts without corrupting the original attributes', async () => {
  const f = await fixture(), segment = 'x'.repeat(14000);
  const server = createEyeBrowserServer({ ...f.options, userAttributes: { segment } });
  const prepared = await server.prepare(['checkout']);
  const choice = prepared.choices[0]!;
  expect(choice.receipt.length).toBeGreaterThan(16000);
  expect(choice.receipt.length).toBeLessThanOrEqual(24000);
  expect(await server.receive([{ eventId: 'large-valid', receipt: choice.receipt, occurredAt: prepared.serverNow }]))
    .toEqual([{ eventId: 'large-valid', accepted: true }]);
  expect(f.events[0]!.event).toMatchObject({ kind: 'exposure', userAttributes: { segment } });
  await waitOnExecutionContext(f.options.ctx);
});

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
