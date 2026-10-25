import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { createEye, encodedSize, type EyeOptions } from '../../src/client.js';
import { createEyeRequest } from '../../src/request.js';
import { EyeWorker } from '../../src/runtime/service.js';
import type { EventEnvelope } from '../../src/core/types.js';

const subject = { cid: 'browser' }, at = 1_800_000_000_000;
function fixture(limits?: EyeOptions['collectionLimits']) {
  const ctx = createExecutionContext(), service = new EyeWorker(ctx, env), received: EventEnvelope[] = [];
  const ingest = vi.spyOn(service, 'ingest').mockImplementation(async batch => { received.push(...batch); });
  const options = { service, ctx, siteId: 'site', ...(limits === undefined ? {} : { collectionLimits: limits }) };
  return { ctx, options, received, ingest, eye: createEye(options) };
}
const track = { subject, name: 'view', eventId: 'one' };
function sizeOf(eventId: string, value = 'x') {
  return encodedSize({ siteId: 'site', receivedAt: at,
    event: { kind: 'track', subject, name: 'view', eventId, occurredAt: at, attributes: { value } } }) + 200;
}

it('limits total accepted events across flushes, isolates clients, and skips exhausted payloads', async () => {
  const f = fixture({ maxEvents: 1 });
  expect(f.eye.track(track).accepted).toBe(true);
  await f.eye.flush();
  const unread = { get subject(): typeof subject { throw new Error('Must not inspect exhausted request payload'); }, name: 'view' };
  expect(f.eye.track(unread)).toMatchObject({ accepted: false, error: { code: 'unavailable', message: expect.stringContaining('budget') } });
  expect(createEye(f.options).track(track).accepted).toBe(true);
  await waitOnExecutionContext(f.ctx);
  expect(f.received).toHaveLength(2);
});

it.each(['subject', 'attribute'])('rechecks event allowance after a reentrant %s getter', async kind => {
  const f = fixture({ maxEvents: 1 });
  const submitInner = () => expect(f.eye.track({ ...track, eventId: 'inner' }).accepted).toBe(true);
  const input = kind === 'subject'
    ? { ...track, eventId: 'outer', get subject() { submitInner(); return subject; } }
    : { ...track, eventId: 'outer', attributes: { get value() { submitInner(); return 'value'; } } };
  expect(f.eye.track(input)).toMatchObject({ accepted: false, error: { code: 'unavailable' } });
  await f.eye.flush(); await waitOnExecutionContext(f.ctx);
  expect(f.received.map(row => row.event.eventId)).toEqual(['inner']);
});

it('counts exact estimated bytes cumulatively and does not charge rejected events', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  try {
    const size = sizeOf('one'), f = fixture({ maxBytes: size * 2 - 1 });
    expect(f.eye.track({ ...track, attributes: { value: NaN } }).accepted).toBe(false);
    expect(f.eye.track({ ...track, attributes: { value: 'x' } }).accepted).toBe(true);
    await f.eye.flush();
    expect(f.eye.track({ ...track, eventId: 'two', attributes: { value: 'x' } })).toMatchObject({ accepted: false, error: { code: 'unavailable' } });
    await waitOnExecutionContext(f.ctx);
    expect(f.received).toHaveLength(1);
    const exact = fixture({ maxBytes: size });
    expect(exact.eye.track({ ...track, attributes: { value: 'x' } }).accepted).toBe(true);
    await exact.eye.flush(); await waitOnExecutionContext(exact.ctx);
  } finally { clock.mockRestore(); }
});

it.each([false, true])('includes in-flight bytes and releases them on settlement (failure=%s)', async failure => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  try {
    const size = sizeOf('one'), f = fixture({ maxPendingBytes: size });
    let settle!: () => void;
    f.ingest.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      settle = () => failure ? reject(new Error('offline')) : resolve();
    }));
    expect(f.eye.track({ ...track, attributes: { value: 'x' } }).accepted).toBe(true);
    const flushing = f.eye.flush(); await Promise.resolve();
    expect(f.ingest).toHaveBeenCalledTimes(1);
    expect(f.eye.track({ ...track, eventId: 'two', attributes: { value: 'x' } })).toMatchObject({ accepted: false, error: { code: 'unavailable' } });
    settle();
    if (failure) await expect(flushing).rejects.toThrow('offline'); else await flushing;
    expect(f.eye.track({ ...track, eventId: 'two', attributes: { value: 'x' } }).accepted).toBe(true);
    await f.eye.flush(); await waitOnExecutionContext(f.ctx);
    expect(f.ingest).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); }
});

it('releases earlier batches while draining and preserves queued events and ordering', async () => {
  const f = fixture({ maxEvents: 220, maxPendingBytes: 1_000_000 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.ingest.mockImplementationOnce(async batch => { f.received.push(...batch); await gate; });
  for (let i = 0; i < 150; i++) expect(f.eye.track({ ...track, eventId: String(i) }).accepted).toBe(true);
  const flushing = f.eye.flush(); await Promise.resolve();
  for (let i = 150; i < 220; i++) expect(f.eye.track({ ...track, eventId: String(i) }).accepted).toBe(true);
  release(); await flushing; await waitOnExecutionContext(f.ctx);
  expect(f.received.map(row => row.event.eventId)).toEqual(Array.from({ length: 220 }, (_, i) => String(i)));
  expect(f.ingest.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 20]);
});

it('rejects excessive keys before reading later values and snapshots accepted attributes once', async () => {
  const f = fixture({ maxAttributeKeys: 2, maxAttributeStringLength: 4 });
  const unread = vi.fn(() => { throw new Error('Too late'); });
  expect(f.eye.track({ ...track, attributes: { a: 1, b: 2, get c() { return unread(); } } })).toMatchObject({ accepted: false, error: { message: 'Too many attribute keys' } });
  expect(unread).not.toHaveBeenCalled();
  expect(f.eye.track({ ...track, attributes: { a: '12345' } }).accepted).toBe(false);
  let reads = 0;
  const attributes = { get value() { reads++; return '😀😀'; } };
  expect(f.eye.track({ ...track, attributes }).accepted).toBe(true);
  expect(reads).toBe(1);
  await f.eye.flush(); await waitOnExecutionContext(f.ctx);
  expect(f.received[0]!.event.attributes).toEqual({ value: '😀😀' });
});

it('keeps exact UTF-8 envelope checks after cheap string checks', async () => {
  const f = fixture();
  expect(f.eye.track({ ...track, attributes: { value: '한'.repeat(40_000) } })).toMatchObject({ accepted: false, error: { message: expect.stringContaining('100 KB') } });
  const attrs = { value: 'original' };
  expect(f.eye.track({ ...track, attributes: attrs }).accepted).toBe(true);
  attrs.value = 'changed';
  await f.eye.flush(); await waitOnExecutionContext(f.ctx);
  expect(f.received[0]!.event.attributes).toEqual({ value: 'original' });
});

it('leaves cache access lazy for collection but preserves eager decision setting validation', async () => {
  const f = fixture(), cache = vi.fn(() => { throw new Error('cache access'); });
  const eye = createEye({ ...f.options, decisions: { secret: 'a'.repeat(32), tokens: {}, get cache() { return cache(); } } });
  expect(eye.track(track).accepted).toBe(true);
  await expect(eye.state()).resolves.toEqual({});
  expect(cache).not.toHaveBeenCalled();
  expect(() => eye.decide({ subject, experimentId: 'checkout' })).toThrow('cache access');
  expect(() => createEye({ ...f.options, decisions: { secret: 'short' } })).toThrow('32 UTF-8 bytes');
  expect(() => createEye({ ...f.options, decisions: { secret: 'a'.repeat(32), freshMs: 10, maxAgeMs: 1 } })).toThrow('freshness');
  await f.eye.flush(); await waitOnExecutionContext(f.ctx);
});

it('request wrapper reports budget rejection without losing the already accepted goal', async () => {
  const f = fixture({ maxEvents: 1 }), onError = vi.fn();
  const eye = createEyeRequest({ ...f.options, subject, onError });
  expect(eye.goal({ goalId: 'purchase', value: 20 }).accepted).toBe(true);
  expect(eye.goal({ goalId: 'purchase', value: 20 })).toMatchObject({ accepted: false, error: { code: 'unavailable' } });
  expect(onError).toHaveBeenCalledTimes(1);
  await waitOnExecutionContext(f.ctx);
  expect(f.received).toHaveLength(1);
});

it.each([{ maxEvents: 0 }, { maxBytes: 1.5 }, { maxPendingBytes: Infinity }, { maxAttributeKeys: -1 }, { maxAttributeStringLength: NaN }])('rejects invalid collection limit %j', collectionLimits => {
  expect(() => fixture(collectionLimits)).toThrow('positive safe integer');
});
