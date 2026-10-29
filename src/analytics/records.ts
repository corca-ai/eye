import type { Attributes } from '../core/types.js';

export const STORED_TABLES = ['events', 'observations', 'identity_links', 'policies', 'attribute_keys'] as const;
export type AnalyticsTable = typeof STORED_TABLES[number] | 'credits' | 'decisions';
/** Flat indexed fields plus immutable JSON details, shared by the Stream fan-out schema. */
export type AnalyticsRecord = {
  schema_version: number; table_name: AnalyticsTable; site_id: string; record_id: string; revision: number;
  occurred_at: number; received_at: number; subject_key: string; cid: string | null; uid: string | null;
  experiment_id: string | null; arm_id: string | null; goal_id: string | null; assignment_id: string | null;
  observation_id: string | null; status: string | null; value: number | null; attributes_json: string; payload_json: string;
};
export interface RecordContext { siteId: string; subjectKey: string; cid?: string; uid?: string }
export function analyticsRecord(
  context: RecordContext, table: AnalyticsTable, recordId: string, revision: number,
  occurredAt: number, receivedAt: number, payload: object,
  fields: Partial<Pick<AnalyticsRecord, 'experiment_id' | 'arm_id' | 'goal_id' | 'assignment_id' | 'observation_id' | 'status' | 'value'>> = {},
  attributes: Attributes = {},
): AnalyticsRecord {
  return {
    schema_version: 1, table_name: table, site_id: context.siteId, record_id: recordId, revision,
    occurred_at: occurredAt, received_at: receivedAt, subject_key: context.subjectKey,
    cid: context.cid ?? null, uid: context.uid ?? null, experiment_id: null, arm_id: null, goal_id: null,
    assignment_id: null, observation_id: null, status: null, value: null, ...fields,
    attributes_json: JSON.stringify(attributes), payload_json: JSON.stringify(payload),
  };
}

/** Stable daily dictionary rows deduplicate retries and preserve mixed attribute types. */
export function* attributeRecords(record: AnalyticsRecord, include: (recordId: string) => boolean = () => true): Generator<AnalyticsRecord> {
  if (record.table_name !== 'events' && record.table_name !== 'observations') return;
  const sources: [string, Record<string, unknown>][] = [['event', JSON.parse(record.attributes_json) as Record<string, unknown>]];
  if (record.table_name === 'observations') sources[0]![0] = 'user';
  if (record.table_name === 'events') {
    const payload = JSON.parse(record.payload_json) as { userAttributes?: Record<string, unknown> };
    if (payload.userAttributes) sources.push(['user', payload.userAttributes]);
  }
  for (const [source, attrs] of sources) for (const [key, value] of Object.entries(attrs)) {
    const type = value === null ? 'null' : typeof value;
    const recordId = JSON.stringify([Math.floor(record.occurred_at / 86_400_000), source, key, type]);
    if (!include(recordId)) continue;
    yield {
      ...record, schema_version: 1, table_name: 'attribute_keys' as const,
      record_id: recordId,
      revision: 1, occurred_at: Math.floor(record.occurred_at / 86_400_000) * 86_400_000, cid: null, uid: null, subject_key: '', experiment_id: null, arm_id: null,
      goal_id: null, assignment_id: null, observation_id: null, status: null, value: null, attributes_json: '{}',
      payload_json: JSON.stringify({ key, type, source }),
    };
  }
}
