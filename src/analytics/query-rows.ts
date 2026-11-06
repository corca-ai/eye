import { EyeError, invariant } from '../core/errors.js';
import type { ArmRow, AttributeField, AttributeKeyRow, AttributeValueRow, EventListRow, EventSeriesRow, GoalRow, LearningRow, PolicyHistoryRow, Scalar, TimelineRow, TrafficRow } from './types.js';

export type Row = Record<string, unknown>;
export function object(value: unknown): Row {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'unavailable', 'Malformed analytics response');
  return value as Row;
}
function text(row: Row, key: string): string {
  const value = row[key]; invariant(typeof value === 'string', 'unavailable', `Invalid analytics column: ${key}`); return value;
}
export function numeric(row: Row, key: string): number {
  const value = row[key];
  invariant(typeof value === 'number' && Number.isFinite(value), 'numeric_range', `Analytics column ${key} is not a finite number`);
  return value;
}
function nullableNumeric(row: Row, key: string): number | null { return row[key] === null ? null : numeric(row, key); }
function allocationMode(row: Row): 'policy' | 'default' {
  // Legacy remote readers/mocks without the added dimension describe policy only.
  const mode = row.allocation_mode ?? 'policy';
  invariant(mode === 'policy' || mode === 'default', 'unavailable', 'Invalid allocation mode');
  return mode;
}
function scalar(value: unknown): Scalar {
  invariant(value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)), 'unavailable', 'Invalid analytics scalar');
  return value;
}
function nullableText(row: Row, key: string): string | null { return row[key] === null ? null : text(row, key); }
function jsonObject(row: Row, key: string): Row {
  let parsed: unknown;
  try { parsed = JSON.parse(text(row, key)); } catch { throw new EyeError('unavailable', `Invalid analytics JSON: ${key}`); }
  return object(parsed);
}
function eventAttributes(row: Row): Record<string, Scalar> {
  return Object.fromEntries(Object.entries(jsonObject(row, 'attributes_json')).map(([key, value]) => [key, scalar(value)]));
}
export function goalRow(row: Row): GoalRow {
  return { goalId: text(row, 'goal_id'), events: numeric(row, 'events'), totalValue: numeric(row, 'total_value'), latestReceivedAt: numeric(row, 'latest_received_at') };
}
function eventPayload(row: Row): Row {
  const payload = jsonObject(row, 'payload_json');
  if (row.schema_version !== 2 || row.table_name !== 'events') return payload;
  invariant(payload.kind === 'track' || payload.kind === 'goal', 'unavailable', 'Invalid compact event kind');
  const { attributes: hasAttributes, ...details } = payload;
  return { ...details, occurredAt: numeric(row, 'occurred_at'),
    subject: { cid: text(row, 'cid'), ...(row.uid === null ? {} : { uid: text(row, 'uid') }) },
    ...(hasAttributes === true ? { attributes: jsonObject(row, 'attributes_json') } : {}),
    ...(payload.kind === 'goal' ? { goalId: text(row, 'goal_id'), value: numeric(row, 'value') } : {}),
    processingStatus: text(row, 'status') };
}
export function timelineRow(row: Row): TimelineRow {
  const table = text(row, 'table_name');
  invariant(table === 'events' || table === 'observations' || table === 'credits' || table === 'decisions' || table === 'identity_links', 'unavailable', 'Unknown analytics table');
  return {
    table, recordId: text(row, 'record_id'), revision: numeric(row, 'revision'),
    occurredAt: numeric(row, 'occurred_at'), receivedAt: numeric(row, 'received_at'),
    cid: nullableText(row, 'cid'), uid: nullableText(row, 'uid'), subjectKey: text(row, 'subject_key'),
    experimentId: nullableText(row, 'experiment_id'), armId: nullableText(row, 'arm_id'), goalId: nullableText(row, 'goal_id'),
    status: nullableText(row, 'status'), value: nullableNumeric(row, 'value'),
    attributes: eventAttributes(row),
    payload: eventPayload(row),
  };
}

export function armRow(row: Row, groups: readonly AttributeField[]): ArmRow {
  return {
    armId: text(row, 'arm_id'), generation: numeric(row, 'generation'), observationWindowMs: numeric(row, 'window_ms'),
    groups: groups.map((_, i) => scalar(row[`group_${i}`])), completed: numeric(row, 'completed'), pending: numeric(row, 'pending'),
    allocationMode: allocationMode(row), subjects: numeric(row, 'subjects'), totalValue: numeric(row, 'total_value'), learningValue: numeric(row, 'learning_value'),
    meanValue: nullableNumeric(row, 'mean_value'), latestReceivedAt: numeric(row, 'latest_received_at'),
  };
}

export function learningRow(row: Row): LearningRow {
  return {
    experimentId: text(row, 'experiment_id'), armId: text(row, 'arm_id'), generation: numeric(row, 'generation'),
    observationWindowMs: numeric(row, 'window_ms'), completed: numeric(row, 'completed'), learningValue: numeric(row, 'learning_value'),
    meanValue: numeric(row, 'mean_value'), latestReceivedAt: numeric(row, 'latest_received_at'),
  };
}

export function trafficRow(row: Row): TrafficRow {
  return { bucketStart: numeric(row, 'bucket_start'), armId: text(row, 'arm_id'),
    generation: numeric(row, 'generation'), assignments: numeric(row, 'assignments'), exposures: numeric(row, 'exposures'),
    allocationMode: allocationMode(row), assignmentShare: nullableNumeric(row, 'assignment_share'), exposureShare: nullableNumeric(row, 'exposure_share') };
}

export function policyRow(row: Row): PolicyHistoryRow {
  const payload = jsonObject(row, 'payload_json');
  return { occurredAt: numeric(row, 'occurred_at'), recordId: text(row, 'record_id'), armId: text(row, 'arm_id'), generation: numeric(payload, 'generation'),
    probability: numeric(payload, 'probability'), meanReward: nullableNumeric(payload, 'meanReward'), score: nullableNumeric(payload, 'score'), scoreScale: numeric(payload, 'scoreScale'), reason: text(payload, 'reason'), status: text(payload, 'status') };
}

export function attributeKeyRow(row: Row): AttributeKeyRow {
  const type = text(row, 'attribute_type'), source = text(row, 'attribute_source');
  invariant(type === 'string' || type === 'number' || type === 'boolean' || type === 'null', 'unavailable', 'Invalid attribute type');
  invariant(source === 'event' || source === 'user', 'unavailable', 'Invalid attribute source');
  return { key: text(row, 'attribute_key'), type, source, latestReceivedAt: numeric(row, 'latest_received_at') };
}

export function eventListRow(row: Row): EventListRow {
  return { recordId: text(row, 'record_id'),
    occurredAt: numeric(row, 'occurred_at'), receivedAt: numeric(row, 'received_at'),
    name: nullableText(row, 'event_name') ?? nullableText(row, 'goal_id') ?? nullableText(row, 'event_kind') ?? 'event',
    cid: nullableText(row, 'cid'), uid: nullableText(row, 'uid'), goalId: nullableText(row, 'goal_id'),
    status: nullableText(row, 'status'), value: nullableNumeric(row, 'value'),
    attributes: eventAttributes(row),
  };
}

export function eventSeriesRow(row: Row): EventSeriesRow {
  return { bucketStart: numeric(row, 'bucket_start'), events: numeric(row, 'events'),
    latestReceivedAt: numeric(row, 'latest_received_at') };
}

export function attributeValueRow(row: Row): AttributeValueRow {
  return { value: scalar(row.attribute_value), events: numeric(row, 'events'), latestReceivedAt: numeric(row, 'latest_received_at') };
}
