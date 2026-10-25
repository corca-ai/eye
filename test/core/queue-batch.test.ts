import { expect, it, vi } from 'vitest';
import { packEvents, packIngestion, unpackEvents, QUEUE_BATCH_BYTES } from '../../src/runtime/queue-batch.js';
import { encodedSize, MAX_EVENT_BYTES, MAX_BATCH_BYTES } from '../../src/client.js';
import type { EventEnvelope } from '../../src/core/types.js';
import { settings } from '../../src/core/validation.js';
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

function shown(i: number, minHoldMs = 0, detail = ''): EventEnvelope {
  return { siteId: 'site', receivedAt: 1, event: { kind: 'exposure', eventId: `e-${i}`, occurredAt: 1,
    subject: { cid: `c-${i}` }, assignment: { assignmentId: `a-${i}`, experimentId: 'exp', armId: 'a',
      generation: 1, assignedAt: 0, policyRevision: 1, probability: 1, settings: settings({ minHoldMs }) },
    sample: { sampleId: `s-${i}`, startAt: 1 }, attributionWindowMs: 1000, attributes: { detail },
  } };
}

it('uses self-contained dictionaries only when complete encoded packets become smaller', () => {
  const events = Array.from({ length: 100 }, (_, i) => shown(i));
  const packets = packIngestion(events);
  expect(packets).toHaveLength(1);
  expect(packets[0]!.settings).toHaveLength(1);
  expect(packets.flatMap(unpackEvents)).toEqual(events);
  expect(encodedSize(packets[0])).toBeLessThan(encodedSize({ version: 2, events }));
  expect(encodedSize(packets[0])).toBeLessThanOrEqual(QUEUE_BATCH_BYTES);
  expect(packEvents([shown(0)])[0]!.settings).toBeUndefined();
  expect(packIngestion(events.slice(0, 20))[0]!.settings).toBeUndefined();
  expect(packEvents(Array.from({ length: 20 }, (_, i) => shown(i, i)))[0]!.settings).toBeUndefined();
});

it('rebuilds reference indices on byte and count splits, including mixed kinds and large singletons', () => {
  const events = Array.from({ length: 230 }, (_, i) => i % 3 ? shown(i, i % 13, '한'.repeat(200)) : envelope(i));
  events.splice(11, 0, shown(1000, 0, 'x'.repeat(70000)));
  const packets = packEvents(events);
  expect(packets.flatMap(unpackEvents)).toEqual(events);
  for (const packet of packets) {
    expect(packet.events.length).toBeLessThanOrEqual(100);
    expect(encodedSize(packet)).toBeLessThanOrEqual(packet.events.length === 1 ? MAX_EVENT_BYTES + 100 : QUEUE_BATCH_BYTES);
    if (packet.settings) {
      expect(encodedSize(packet)).toBeLessThan(encodedSize({ version: 2, events: unpackEvents(packet) }));
      const restored = unpackEvents(packet) as EventEnvelope[];
      const exposures = restored.filter(e => e.event.kind === 'exposure');
      if (exposures.length > 1 && exposures[0]!.event.kind === 'exposure' && exposures[1]!.event.kind === 'exposure') {
        expect(exposures[0]!.event.assignment.settings).not.toBe(exposures[1]!.event.assignment.settings);
      }
    }
  }
});

it('isolates invalid references and settings entries without losing valid siblings', () => {
  const packet = packIngestion(Array.from({ length: 100 }, (_, i) => shown(i)))[0]!;
  const compressed = packet.events[0]!;
  const compressedEvent = compressed.event;
  if (compressedEvent.kind !== 'exposure') throw new Error('Expected exposure');
  const bad = (index: unknown) => ({ ...compressed, event: { ...compressedEvent, assignment: { ...compressedEvent.assignment, settings: index } } });
  for (const index of [-1, 0.5, NaN, Infinity, 2 ** 53, 100]) {
    expect(unpackEvents({ ...packet, events: [compressed, bad(index), envelope(3)] })).toEqual([shown(0), null, envelope(3)]);
  }
  expect(unpackEvents({ ...packet, settings: [packet.settings![0], { minHoldMs: 'bad' }], events: [bad(1), compressed] })).toEqual([null, shown(0)]);
  expect(() => unpackEvents({ ...packet, settings: Array(101).fill(packet.settings![0]) })).toThrow('dictionary');
  const oversized = { ...compressed, event: { ...compressed.event, attributes: { detail: 'x'.repeat(MAX_EVENT_BYTES) } } };
  expect(unpackEvents({ ...packet, events: [oversized, compressed] })).toEqual([null, shown(0)]);
});

it('keeps decoded ingestion admission limits even when repeated settings compress', () => {
  const event = shown(0, 0, 'x'.repeat(MAX_EVENT_BYTES - 200 - encodedSize(shown(0))));
  expect(packIngestion([event]).flatMap(unpackEvents)).toEqual([event]);
  expect(() => packIngestion([shown(0, 0, event.event.attributes!.detail + 'x')])).toThrow('encoded size');
  expect(() => packIngestion(Array.from({ length: 10 }, (_, i) => shown(i, 0, 'x'.repeat(25000))))).toThrow('encoded size');
});
it('rejects unwrapped events, invalid wrappers and oversized events', () => {
  expect(() => unpackEvents(envelope(1))).toThrow();
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
