import type { Attributes } from '../core/types.js';

export type AnalyticsTable = 'events' | 'observations' | 'credits' | 'decisions' | 'identity_links' | 'policies' | 'attribute_keys';
/** Flat indexed fields plus immutable JSON details, shared by the Stream fan-out schema. */
export type AnalyticsRecord = {
  schema_version: number; table_name: AnalyticsTable; site_id: string; record_id: string; revision: number;
  occurred_at: number; received_at: number; subject_key: string; state_key: string; cid: string | null; uid: string | null;
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
    occurred_at: occurredAt, received_at: receivedAt, subject_key: context.subjectKey, state_key: context.subjectKey,
    cid: context.cid ?? null, uid: context.uid ?? null, experiment_id: null, arm_id: null, goal_id: null,
    assignment_id: null, observation_id: null, status: null, value: null, ...fields,
    attributes_json: JSON.stringify(attributes), payload_json: JSON.stringify(payload),
  };
}

/** Stable daily dictionary rows deduplicate retries and preserve mixed attribute types. */
export function attributeRecords(record: AnalyticsRecord): AnalyticsRecord[] {
  const sources: [string, Record<string, unknown>][] = [['event', JSON.parse(record.attributes_json) as Record<string, unknown>]];
  if (record.table_name === 'observations') sources[0]![0] = 'user';
  if (record.table_name === 'events') {
    const payload = JSON.parse(record.payload_json) as { userAttributes?: Record<string, unknown> };
    if (payload.userAttributes) sources.push(['user', payload.userAttributes]);
  }
  if (record.table_name !== 'events' && record.table_name !== 'observations') return [];
  return sources.flatMap(([source, attrs]) => Object.entries(attrs).map(([key, value]) => ({
    ...record, table_name: 'attribute_keys' as const,
    record_id: JSON.stringify([Math.floor(record.occurred_at / 86_400_000), source, key, value === null ? 'null' : typeof value]),
    revision: 1, occurred_at: Math.floor(record.occurred_at / 86_400_000) * 86_400_000, cid: null, uid: null, subject_key: '', state_key: '', experiment_id: null, arm_id: null,
    goal_id: null, assignment_id: null, observation_id: null, status: null, value: null, attributes_json: '{}',
    payload_json: JSON.stringify({ key, type: value === null ? 'null' : typeof value, source }),
  })));
}
