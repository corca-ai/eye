import { invariant } from '../core/errors.js';
import { attributeRecords, type AnalyticsRecord } from './records.js';
import { TABLES } from './sql.js';

/** Below the Stream's 5 MB request ceiling, including the enclosing JSON array. */
export const EXPORT_BATCH_BYTES = 4_500_000;
const encoder = new TextEncoder();
export function validateExport(record: AnalyticsRecord): void {
  invariant(record.schema_version === 1 && TABLES.includes(record.table_name), 'invalid_input', 'Unknown analytics schema');
  for (const key of ['site_id', 'record_id', 'subject_key', 'state_key', 'attributes_json', 'payload_json'] as const) {
    invariant(typeof record[key] === 'string', 'invalid_input', `Invalid analytics field: ${key}`);
  }
  for (const key of ['cid', 'uid', 'experiment_id', 'arm_id', 'goal_id', 'assignment_id', 'observation_id', 'status'] as const) {
    invariant(record[key] === null || typeof record[key] === 'string', 'invalid_input', `Invalid analytics field: ${key}`);
  }
  for (const key of ['revision', 'occurred_at', 'received_at'] as const) {
    invariant(Number.isSafeInteger(record[key]) && record[key] >= (key === 'revision' ? 1 : 0), 'invalid_input', `Invalid analytics field: ${key}`);
  }
  invariant(record.value === null || (typeof record.value === 'number' && Number.isFinite(record.value)), 'numeric_range', 'Invalid analytics value');
}
/** Expand before sizing: a valid event's dictionary may span several requests.
 * Yield wire records directly so callers never expand an already-sized batch.
 */
export function* exportBatches(rows: readonly { record: AnalyticsRecord }[]): Generator<AnalyticsRecord[]> {
  let batch: AnalyticsRecord[] = [], bytes = 2;
  const keys = new Set<string>();
  for (const row of rows) {
    validateExport(row.record);
    const expanded = [row.record, ...attributeRecords(row.record)];
    for (const [index, record] of expanded.entries()) {
      if (index !== 0) validateExport(record);
      const key = index === 0 ? null : JSON.stringify([record.site_id, record.record_id]);
      if (key !== null && keys.has(key)) continue;
      const size = encoder.encode(JSON.stringify(record)).byteLength;
      invariant(size + 2 <= EXPORT_BATCH_BYTES, 'invalid_input', 'Analytics record exceeds the Stream request limit');
      if (bytes + size + (batch.length ? 1 : 0) > EXPORT_BATCH_BYTES) {
        yield batch; batch = []; bytes = 2; keys.clear();
      }
      bytes += size + (batch.length ? 1 : 0); batch.push(record);
      if (key !== null) keys.add(key);
    }
  }
  if (batch.length > 0) yield batch;
}

export function exportRecords(rows: readonly { record: AnalyticsRecord }[]): AnalyticsRecord[] {
  const result: AnalyticsRecord[] = [], keys = new Set<string>();
  for (const { record } of rows) {
    result.push(record);
    for (const dictionary of attributeRecords(record)) {
      const key = JSON.stringify([dictionary.site_id, dictionary.record_id]);
      if (!keys.has(key)) { keys.add(key); validateExport(dictionary); result.push(dictionary); }
    }
  }
  return result;
}
