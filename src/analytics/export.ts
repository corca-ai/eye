import { invariant } from '../core/errors.js';
import type { AnalyticsRecord } from './records.js';
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
export function* exportBatches<T extends { record: AnalyticsRecord }>(rows: readonly T[]): Generator<T[]> {
  let batch: T[] = [], bytes = 2;
  for (const row of rows) {
    validateExport(row.record);
    const size = encoder.encode(JSON.stringify(row.record)).byteLength + 1;
    invariant(size + 2 <= EXPORT_BATCH_BYTES, 'invalid_input', 'Analytics record exceeds the Stream request limit');
    if (bytes + size > EXPORT_BATCH_BYTES) { yield batch; batch = []; bytes = 2; }
    batch.push(row); bytes += size;
  }
  if (batch.length > 0) yield batch;
}
