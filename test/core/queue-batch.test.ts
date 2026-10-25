import { expect, it, vi } from 'vitest';
import { packEvents, packIngestion, unpackEvents, QUEUE_BATCH_BYTES } from '../../src/runtime/queue-batch.js';
import { encodedSize, MAX_EVENT_BYTES, MAX_BATCH_BYTES } from '../../src/client.js';
import type { EventEnvelope } from '../../src/core/types.js';
const envelope = (i: number, detail = ''): EventEnvelope => ({ siteId: 'site', receivedAt: 1,
  event: { kind: 'track', eventId: String(i), occurredAt: 1, subject: { cid: 'c' }, name: 'view', attributes: { detail } } });
it('packs without reordering, respects UTF-8 bytes and the decoder event limit', () => {
  const events = Array.from({ length: 250 }, (_, i) => envelope(i, i % 2 ? '한'.repeat(1500) : ''));
  const batches = packEvents(events);
  expect(batches.length).toBeLessThan(events.length);
  expect(batches.flatMap(unpackEvents)).toEqual(events);
  for (const batch of batches) {
    expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(QUEUE_BATCH_BYTES);
    expect(batch.events.length).toBeLessThanOrEqual(100);
  }
  expect(packEvents(Array.from({ length: 201 }, (_, i) => envelope(i))).map(b => b.events.length)).toEqual([100, 100, 1]);
});
it('accepts the single-event wire format and rejects invalid wrappers and oversized events', () => {
  expect(unpackEvents(envelope(1))).toEqual([envelope(1)]);
  expect(packEvents([])).toEqual([]);
  expect(() => unpackEvents({ version: 2, events: 'bad' })).toThrow();
  expect(() => unpackEvents({ version: 2, events: Array(101).fill(null) })).toThrow();
  expect(() => packEvents([envelope(1, 'x'.repeat(100_000))])).toThrow();
});

it('sends a large SDK-valid event alone without losing small siblings', () => {
  const events = [envelope(1), envelope(2, 'x'.repeat(70_000)), envelope(3)];
  const batches = packEvents(events);
  expect(batches.map(b => b.events.length)).toEqual([1, 1, 1]);
  expect(batches.flatMap(unpackEvents)).toEqual(events);
});

it('measures canonical envelopes once and produces identical UTF-8 Queue packets', () => {
  const events = [envelope(1, '한'.repeat(3000)), envelope(2, 'x'.repeat(70_000)), envelope(3)];
  const expected = packEvents(events);
  const stringify = vi.spyOn(JSON, 'stringify');
  let actual, measured;
  try {
    actual = packIngestion(events);
    measured = stringify.mock.calls.map(([value]) => value);
  } finally { stringify.mockRestore(); }
  expect(measured).toEqual(events);
  expect(actual).toEqual(expected);
});

it('preserves exact ingestion byte overhead, total limits and event count limits', () => {
  const exact = envelope(1, 'x'.repeat(MAX_EVENT_BYTES - 200 - encodedSize(envelope(1))));
  expect(packIngestion([exact])).toHaveLength(1);
  expect(() => packIngestion([envelope(1, exact.event.attributes!.detail + 'x')])).toThrow('encoded size');
  const perEvent = MAX_BATCH_BYTES / 3;
  const full = Array.from({ length: 3 }, (_, i) => envelope(i, 'x'.repeat(perEvent - 200 - encodedSize(envelope(i)))));
  expect(packIngestion(full).flatMap(unpackEvents)).toEqual(full);
  expect(() => packIngestion([...full, envelope(4)])).toThrow('encoded size');
  expect(() => packIngestion(Array.from({ length: 101 }, (_, i) => envelope(i)))).toThrow('100 events');
  expect(packIngestion([])).toEqual([]);
});
