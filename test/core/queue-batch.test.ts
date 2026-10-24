import { expect, it } from 'vitest';
import { packEvents, unpackEvents, QUEUE_BATCH_BYTES } from '../../src/runtime/queue-batch.js';
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
