import { MAX_BATCH_BYTES, MAX_EVENT_BYTES, encodedSize } from '../client.js';
import { invariant } from '../core/errors.js';
import { record, settings as parseSettings } from '../core/validation.js';
import type { Assignment, EventEnvelope, ExposureEvent, ExperimentSettings } from '../core/types.js';

// Ordinary packets fit below one billing unit; SDK-valid larger events stay alone.
export const QUEUE_BATCH_BYTES = 60_000;
type CompactEnvelope = Omit<EventEnvelope, 'event'> & { event: Omit<ExposureEvent, 'assignment'> & {
  assignment: Omit<Assignment, 'settings'> & { settings: number };
} };
export interface EventBatch { version: 2; events: (EventEnvelope | CompactEnvelope)[]; settings?: ExperimentSettings[] }
const RAW_OVERHEAD = '{"version":2,"events":[]}'.length;
const DICTIONARY_OVERHEAD = '{"version":2,"events":[],"settings":[]}'.length;
const encoder = new TextEncoder();
export function packEvents(events: readonly EventEnvelope[]): EventBatch[] { return pack(events, false); }
/** Admission uses original envelope sizes, before any lossless transport encoding. */
export function packIngestion(events: readonly EventEnvelope[]): EventBatch[] {
  invariant(events.length <= 100, 'invalid_input', 'An ingestion batch must contain at most 100 events');
  return pack(events, true);
}
type MeasuredEnvelope = { envelope: EventEnvelope; bytes: number };
function pack(events: readonly EventEnvelope[], ingestion: boolean): EventBatch[] {
  let ingestionBytes = 0;
  const measured = events.map(envelope => {
    const bytes = encodedSize(envelope);
    if (ingestion) {
      ingestionBytes += bytes + 200;
      invariant(bytes + 200 <= MAX_EVENT_BYTES && ingestionBytes <= MAX_BATCH_BYTES,
        'invalid_input', 'Ingestion batch exceeds encoded size limits');
    } else invariant(bytes <= MAX_EVENT_BYTES, 'invalid_input', 'Event exceeds ingestion size limit');
    return { envelope, bytes };
  });
  const ordinary: EventBatch[] = [];
  let packet: EventBatch = { version: 2, events: [] }, packetBytes = RAW_OVERHEAD;
  for (const { envelope, bytes } of measured) {
    if (packet.events.length && (packet.events.length === 100 || packetBytes + bytes + 1 > QUEUE_BATCH_BYTES)) {
      ordinary.push(packet); packet = { version: 2, events: [] }; packetBytes = RAW_OVERHEAD;
    }
    packetBytes += bytes + (packet.events.length ? 1 : 0); packet.events.push(envelope);
    if (packetBytes > QUEUE_BATCH_BYTES) { ordinary.push(packet); packet = { version: 2, events: [] }; packetBytes = RAW_OVERHEAD; }
  }
  if (packet.events.length) ordinary.push(packet);
  // Bytes alone do not reduce Queue operations. Avoid codec work on small batches
  // and retain ordinary packets unless the final message count actually falls.
  if (ordinary.length < 2 || events.filter(e => e.event.kind === 'exposure').length < 2) return ordinary;
  const compact = packWithSettings(measured);
  return compact.length < ordinary.length ? compact : ordinary;
}
function packWithSettings(events: readonly MeasuredEnvelope[]): EventBatch[] {
  const output: EventBatch[] = [];
  let raw: EventBatch = { version: 2, events: [] };
  let compact: EventBatch & { settings: ExperimentSettings[] } = { version: 2, events: [], settings: [] };
  let indices = new Map<string, number>();
  let rawBytes = RAW_OVERHEAD, compactBytes = DICTIONARY_OVERHEAD;
  const reset = () => {
    raw = { version: 2, events: [] }; compact = { version: 2, events: [], settings: [] };
    indices = new Map(); rawBytes = RAW_OVERHEAD; compactBytes = DICTIONARY_OVERHEAD;
  };
  const flush = () => {
    if (raw.events.length) output.push(compactBytes < rawBytes ? compact : raw);
    reset();
  };
  for (const { envelope, bytes: eventBytes } of events) {
    const event = envelope.event;
    const definition = event.kind === 'exposure' ? JSON.stringify(event.assignment.settings) : undefined;
    const definitionBytes = definition === undefined ? 0 : encoder.encode(definition).byteLength;
    // Recompute indices after a split: every final packet owns its whole dictionary.
    const cost = () => {
      const index = definition === undefined ? undefined : indices.get(definition) ?? indices.size;
      const newSetting = definition !== undefined && !indices.has(definition);
      return { index, newSetting,
        raw: rawBytes + eventBytes + (raw.events.length ? 1 : 0),
        compact: compactBytes + eventBytes + (compact.events.length ? 1 : 0)
          + (index === undefined ? 0 : String(index).length - definitionBytes)
          + (newSetting ? definitionBytes + (compact.settings.length ? 1 : 0) : 0),
      };
    };
    let next = cost();
    if (raw.events.length && (raw.events.length === 100 || Math.min(next.raw, next.compact) > QUEUE_BATCH_BYTES)) {
      flush(); next = cost();
    }
    raw.events.push(envelope);
    if (event.kind === 'exposure' && definition !== undefined && next.index !== undefined) {
      if (next.newSetting) { indices.set(definition, next.index); compact.settings.push(event.assignment.settings); }
      compact.events.push({ ...envelope, event: { ...event, assignment: { ...event.assignment, settings: next.index } } });
    } else compact.events.push(envelope);
    rawBytes = next.raw; compactBytes = next.compact;
    if (Math.min(rawBytes, compactBytes) > QUEUE_BATCH_BYTES) flush();
  }
  flush();
  return output;
}

/** Dictionary faults are isolated to referring events; valid siblings still reach
 * normal parsing. Bound expanded bytes before allocating reconstructed envelopes. */
export function unpackEvents(body: unknown): unknown[] {
  const batch = record(body, 'Queue event batch');
  invariant(batch.version === 2 && Array.isArray(batch.events) && batch.events.length <= 100,
    'invalid_input', 'Invalid Queue event batch');
  if (batch.settings === undefined) return batch.events;
  invariant(Array.isArray(batch.settings) && batch.settings.length <= 100, 'invalid_input', 'Invalid Queue settings dictionary');
  const definitions = batch.settings.map(value => {
    try { parseSettings(value); return { value: record(value, 'settings'), bytes: encodedSize(value) }; }
    catch { return null; }
  });
  let expandedBytes = 0;
  return batch.events.map(input => {
    try {
      const envelope = record(input, 'envelope'), event = record(envelope.event, 'event');
      const assignment = event.kind === 'exposure' ? record(event.assignment, 'assignment') : undefined;
      const index = assignment?.settings;
      if (typeof index !== 'number') {
        const bytes = encodedSize(input);
        invariant(bytes <= MAX_EVENT_BYTES && expandedBytes + bytes <= MAX_BATCH_BYTES, 'invalid_input', 'Decoded Queue size exceeds limits');
        expandedBytes += bytes; return input;
      }
      invariant(Number.isSafeInteger(index) && index >= 0 && index < definitions.length, 'invalid_input', 'Invalid Queue settings reference');
      const definition = definitions[index];
      invariant(definition, 'invalid_input', 'Invalid Queue settings entry');
      const bytes = encodedSize(input) - String(index).length + definition.bytes;
      invariant(bytes <= MAX_EVENT_BYTES && expandedBytes + bytes <= MAX_BATCH_BYTES, 'invalid_input', 'Decoded Queue size exceeds limits');
      expandedBytes += bytes;
      return { ...envelope, event: { ...event, assignment: { ...assignment, settings: { ...definition.value } } } };
    } catch { return null; }
  });
}
