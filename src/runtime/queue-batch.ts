import { MAX_BATCH_BYTES, MAX_EVENT_BYTES, encodedSize } from '../client.js';
import { invariant } from '../core/errors.js';
import type { EventEnvelope } from '../core/types.js';

// Pack ordinary events below one 64KB billing unit. Larger SDK-valid events
// travel alone and consume two units; do not narrow the existing public limit.
export const QUEUE_BATCH_BYTES = 60_000;
export interface EventBatch { version: 2; events: EventEnvelope[] }
export function packEvents(events: readonly EventEnvelope[]): EventBatch[] {
  return pack(events, false);
}
/** Parsed Worker envelopes only. Validate ingestion limits and pack using one
 * JSON size calculation per event; never trust sizes supplied over RPC. */
export function packIngestion(events: readonly EventEnvelope[]): EventBatch[] {
  invariant(events.length <= 100, 'invalid_input', 'An ingestion batch must contain at most 100 events');
  return pack(events, true);
}
function pack(events: readonly EventEnvelope[], ingestion: boolean): EventBatch[] {
  const output: EventBatch[] = []; let batch: EventBatch = { version: 2, events: [] }, bytes = 26;
  let ingestionBytes = 0;
  for (const event of events) {
    const eventBytes = encodedSize(event), size = eventBytes + 1;
    if (ingestion) {
      ingestionBytes += eventBytes + 200;
      invariant(eventBytes + 200 <= MAX_EVENT_BYTES && ingestionBytes <= MAX_BATCH_BYTES,
        'invalid_input', 'Ingestion batch exceeds encoded size limits');
    } else invariant(eventBytes <= MAX_EVENT_BYTES, 'invalid_input', 'Event exceeds ingestion size limit');
    if (size + 26 > QUEUE_BATCH_BYTES) {
      if (batch.events.length) output.push(batch);
      output.push({ version: 2, events: [event] });
      batch = { version: 2, events: [] }; bytes = 26;
      continue;
    }
    if (batch.events.length === 100 || bytes + size > QUEUE_BATCH_BYTES) { output.push(batch); batch = { version: 2, events: [] }; bytes = 26; }
    batch.events.push(event); bytes += size;
  }
  if (batch.events.length) output.push(batch);
  return output;
}
export function unpackEvents(body: unknown): unknown[] {
  invariant(typeof body === 'object' && body !== null && 'version' in body && body.version === 2
    && 'events' in body && Array.isArray(body.events) && body.events.length <= 100,
    'invalid_input', 'Invalid Queue event batch');
  return body.events;
}
