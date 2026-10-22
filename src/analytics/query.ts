import { EyeError, invariant } from '../core/errors.js';
import { AnalyticsSQL, TABLES } from './sql.js';
import type { Cursor, QueryPlan } from './sql.js';
import type { AnalyticsTable } from './records.js';
import type { AnalyticsAPI, AnalyticsMeta, AnalyticsPage, ArmQuery, ArmReport, AttributeValuesQuery, AttributeValueRow, GoalQuery, GoalRow, Scalar, SeriesQuery, SeriesRow, TimelinePage, TimelineQuery, TimelineRow } from './types.js';

/** Runtime configuration is supplied by the customer's Worker; the token is a Worker secret. */
export interface AnalyticsEnv {
  EYE_ANALYTICS_WAREHOUSE?: string;
  EYE_ANALYTICS_NAMESPACE?: string;
  EYE_ANALYTICS_TOKEN?: string;
}
type Row = Record<string, unknown>;
function object(value: unknown): Row {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'unavailable', 'Malformed analytics response');
  return value as Row;
}
function text(row: Row, key: string): string {
  const value = row[key]; invariant(typeof value === 'string', 'unavailable', `Invalid analytics column: ${key}`); return value;
}
function numeric(row: Row, key: string): number {
  const value = row[key];
  invariant(typeof value === 'number' && Number.isFinite(value), 'numeric_range', `Analytics column ${key} is not a finite number`);
  return value;
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
async function readResponse(response: Response): Promise<unknown> {
  invariant(response.body, 'unavailable', 'Empty analytics response');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, body = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      invariant(bytes <= 16 * 1024 * 1024, 'invalid_input', 'Analytics response exceeds 16 MiB; reduce the limit or time range');
      body += decoder.decode(part.value, { stream: true });
    }
    body += decoder.decode();
    try { return JSON.parse(body); } catch { throw new EyeError('unavailable', 'Malformed analytics response'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function goalRow(row: Row): GoalRow {
  return { goalId: text(row, 'goal_id'), events: numeric(row, 'events'), totalValue: numeric(row, 'total_value'), latestReceivedAt: numeric(row, 'latest_received_at') };
}
function timelineRow(row: Row): TimelineRow {
  const table = text(row, 'table_name');
  invariant(TABLES.some(t => t === table), 'unavailable', 'Unknown analytics table');
  return {
    table: table as AnalyticsTable, recordId: text(row, 'record_id'), revision: numeric(row, 'revision'),
    occurredAt: numeric(row, 'occurred_at'), receivedAt: numeric(row, 'received_at'),
    cid: nullableText(row, 'cid'), uid: nullableText(row, 'uid'), subjectKey: text(row, 'subject_key'),
    experimentId: nullableText(row, 'experiment_id'), armId: nullableText(row, 'arm_id'), goalId: nullableText(row, 'goal_id'),
    status: nullableText(row, 'status'), value: row.value === null ? null : numeric(row, 'value'),
    attributes: Object.fromEntries(Object.entries(jsonObject(row, 'attributes_json')).map(([key, value]) => [key, scalar(value)])),
    payload: jsonObject(row, 'payload_json'),
  };
}

export class BasinAnalytics implements AnalyticsAPI {
  private readonly endpoint: string;
  private readonly warehouse: string;
  private readonly token: string;
  private readonly namespace: string;
  constructor(env: AnalyticsEnv, private readonly siteId: string, private readonly request: typeof fetch = fetch, private readonly clock: () => number = Date.now) {
    const warehouse = env.EYE_ANALYTICS_WAREHOUSE, token = env.EYE_ANALYTICS_TOKEN;
    invariant(typeof warehouse === 'string' && typeof token === 'string' && token.length > 0, 'unavailable', 'Analytics warehouse and token are not configured');
    const separator = warehouse.indexOf('_'), account = warehouse.slice(0, separator), bucket = warehouse.slice(separator + 1);
    invariant(separator > 0 && /^[a-f0-9]{32}$/i.test(account) && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket), 'invalid_input', 'Invalid analytics warehouse: expected account-id_bucket-name');
    this.warehouse = warehouse; this.token = token; this.namespace = env.EYE_ANALYTICS_NAMESPACE ?? 'eye';
    this.endpoint = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${account}/basin-sql/query/${bucket}`;
  }
  private sql(): AnalyticsSQL { return new AnalyticsSQL(this.namespace, this.siteId, this.clock()); }
  private async execute(plan: QueryPlan): Promise<{ rows: Row[]; meta: AnalyticsMeta }> {
    let response: Response;
    try {
      response = await this.request(this.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ warehouse: this.warehouse, query: plan.sql }), signal: AbortSignal.timeout(30_000), redirect: 'error' });
    } catch { throw new EyeError('unavailable', 'Basin SQL request failed or timed out'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new EyeError(response.status === 400 ? 'invalid_input' : 'unavailable', `Basin SQL returned HTTP ${response.status}; check configuration or narrow the query`);
    }
    let raw: unknown;
    try { raw = await readResponse(response); } catch (error) {
      if (error instanceof EyeError) throw error;
      throw new EyeError('unavailable', 'Basin SQL response failed or timed out');
    }
    const envelope = object(raw);
    invariant(envelope.success === true, 'unavailable', 'Basin SQL could not execute the query');
    const result = object(envelope.result);
    invariant(Array.isArray(result.rows) && result.rows.length <= plan.limit + 1, 'unavailable', 'Malformed analytics rows');
    const metrics = result.metrics === undefined ? {} : object(result.metrics);
    return { rows: result.rows.slice(0, plan.limit).map(object), meta: {
      queriedAt: this.clock(), receivedBefore: plan.receivedBefore, consistency: 'eventual', truncated: result.rows.length > plan.limit,
      bytesScanned: metrics.bytes_scanned === undefined ? null : numeric(metrics, 'bytes_scanned'),
    } };
  }
  async arms(query: ArmQuery): Promise<ArmReport> {
    const result = await this.execute(this.sql().arms(query));
    return { cohortBasis: 'observation_start', meta: result.meta, rows: result.rows.map(row => ({
      armId: text(row, 'arm_id'), generation: numeric(row, 'generation'), observationWindowMs: numeric(row, 'window_ms'),
      groups: (query.groupBy ?? []).map((_, i) => scalar(row[`group_${i}`])), completed: numeric(row, 'completed'), pending: numeric(row, 'pending'),
      interrupted: numeric(row, 'interrupted'), subjects: numeric(row, 'subjects'), totalValue: numeric(row, 'total_value'),
      meanValue: row.mean_value === null ? null : numeric(row, 'mean_value'), latestReceivedAt: numeric(row, 'latest_received_at'),
    })) };
  }
  async timeline(query: TimelineQuery): Promise<TimelinePage> {
    const plan = this.sql().timeline(query), result = await this.execute(plan), rows = result.rows.map(timelineRow), last = rows.at(-1);
    const cursor: Cursor | null = result.meta.truncated && last ? { fingerprint: plan.fingerprint, receivedBefore: plan.receivedBefore, at: last.occurredAt, table: last.table, id: last.recordId } : null;
    return { rows, meta: result.meta, nextCursor: cursor ? JSON.stringify(cursor) : null };
  }
  async goals(query: GoalQuery): Promise<AnalyticsPage<GoalRow>> {
    const result = await this.execute(this.sql().goals(query)); return { meta: result.meta, rows: result.rows.map(goalRow) };
  }
  async series(query: SeriesQuery): Promise<AnalyticsPage<SeriesRow>> {
    const result = await this.execute(this.sql().series(query)); return { meta: result.meta, rows: result.rows.map(row => ({ ...goalRow(row), bucketStart: numeric(row, 'bucket_start') })) };
  }
  async attributeValues(query: AttributeValuesQuery): Promise<AnalyticsPage<AttributeValueRow>> {
    const result = await this.execute(this.sql().attributeValues(query));
    return { meta: result.meta, rows: result.rows.map(row => ({ value: scalar(row.attribute_value), events: numeric(row, 'events'), latestReceivedAt: numeric(row, 'latest_received_at') })) };
  }
}
