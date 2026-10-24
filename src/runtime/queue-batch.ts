import { MAX_EVENT_BYTES } from '../client.js';
import { invariant } from '../core/errors.js';
import type { EventEnvelope } from '../core/types.js';

// Pack ordinary events below one 64KB billing unit. Larger SDK-valid events
// travel alone and consume two units; do not narrow the existing public limit.
export const QUEUE_BATCH_BYTES = 60_000;
export interface EventBatch { version: 2; events: EventEnvelope[] }
export function packEvents(events: readonly EventEnvelope[]): EventBatch[] {
  const output: EventBatch[] = []; let batch: EventBatch = { version: 2, events: [] }, bytes = 26;
  for (const event of events) {
    const size = new TextEncoder().encode(JSON.stringify(event)).length + 1;
    invariant(size - 1 <= MAX_EVENT_BYTES, 'invalid_input', 'Event exceeds ingestion size limit');
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
  if (typeof body === 'object' && body !== null && 'version' in body && body.version === 2) {
    invariant('events' in body && Array.isArray(body.events) && body.events.length <= 100,
      'invalid_input', 'Invalid Queue event batch');
    return body.events;
  }
  // Individual envelopes remain a supported wire format, including external producers.
  return [body];
}
