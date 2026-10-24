import { EyeError, invariant } from '../core/errors.js';
import { AnalyticsSQL, TABLES } from './sql.js';
import type { Cursor, QueryPlan } from './sql.js';
import type { AnalyticsTable } from './records.js';
import type { AnalyticsAPI, AnalyticsMeta, AnalyticsPage, ArmQuery, ArmReport, AttributeValuesQuery, AttributeValueRow, GoalQuery, GoalRow, Scalar, SeriesQuery, SeriesRow, TimelinePage, TimelineQuery, TimelineRow } from './types.js';

/** Internal signal for retrying a smaller result partition, not a transient outage. */
export class AnalyticsCapacityError extends EyeError {
  constructor(message: string) { super('invalid_input', message); }
}

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
      if (bytes > 16 * 1024 * 1024) throw new AnalyticsCapacityError('Analytics response exceeds 16 MiB; reduce the limit or time range');
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
  invariant(table === 'events' || table === 'observations' || table === 'credits' || table === 'decisions' || table === 'identity_links', 'unavailable', 'Unknown analytics table');
  return {
    table, recordId: text(row, 'record_id'), revision: numeric(row, 'revision'),
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
  constructor(env: AnalyticsEnv, private readonly siteId: string, private readonly request: typeof fetch = fetch.bind(globalThis), private readonly clock: () => number = Date.now) {
    const warehouse = env.EYE_ANALYTICS_WAREHOUSE, token = env.EYE_ANALYTICS_TOKEN;
    invariant(typeof warehouse === 'string' && typeof token === 'string' && token.length > 0, 'unavailable', 'Analytics warehouse and token are not configured');
    const separator = warehouse.indexOf('_'), account = warehouse.slice(0, separator), bucket = warehouse.slice(separator + 1);
    invariant(separator > 0 && /^[a-f0-9]{32}$/i.test(account) && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket), 'invalid_input', 'Invalid analytics warehouse: expected account-id_bucket-name');
    this.warehouse = warehouse; this.token = token; this.namespace = env.EYE_ANALYTICS_NAMESPACE ?? 'eye';
    this.endpoint = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${account}/basin-sql/query/${bucket}`;
  }
  /** Internal bounded learning query; never returns a silently truncated input. */
  async learningQuery(sql: string, limit: number): Promise<Record<string, unknown>[]> {
    const result = await this.execute({ sql, limit, receivedBefore: this.clock(), fingerprint: 'learning' });
    if (result.meta.truncated) throw new AnalyticsCapacityError('Learning partition exceeds its row budget');
    return result.rows;
  }
  private sql(): AnalyticsSQL { return new AnalyticsSQL(this.namespace, this.siteId, this.clock()); }
  private async execute(plan: QueryPlan): Promise<{ rows: Row[]; meta: AnalyticsMeta }> {
    let response: Response;
    try {
      response = await this.request(this.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ warehouse: this.warehouse, query: plan.sql }), signal: AbortSignal.timeout(30_000), redirect: 'manual' });
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
  private async armReport(query: ArmQuery, bucketMs?: number) {
    const result = await this.execute(this.sql().arms(query, bucketMs));
    return { rewardBasis: 'raw_attribution' as const, cohortBasis: 'observation_start' as const, meta: result.meta, rows: result.rows.map(row => ({
      ...(bucketMs === undefined ? {} : { bucketStart: numeric(row, 'bucket_start') }),
      armId: text(row, 'arm_id'), generation: numeric(row, 'generation'), observationWindowMs: numeric(row, 'window_ms'),
      groups: (query.groupBy ?? []).map((_, i) => scalar(row[`group_${i}`])), completed: numeric(row, 'completed'), pending: numeric(row, 'pending'),
      interrupted: numeric(row, 'interrupted'), subjects: numeric(row, 'subjects'), totalValue: numeric(row, 'total_value'), learningValue: numeric(row, 'learning_value'),
      meanValue: row.mean_value === null ? null : numeric(row, 'mean_value'), latestReceivedAt: numeric(row, 'latest_received_at'),
    })) };
  }
  async arms(query: ArmQuery): Promise<ArmReport> { return this.armReport(query); }
  async armSeries(query: import('./types.js').ArmSeriesQuery) {
    invariant(Number.isSafeInteger(query.bucketMs) && query.bucketMs > 0, 'invalid_input', 'bucketMs must be positive integer milliseconds');
    const result = await this.armReport(query, query.bucketMs);
    return { ...result, rows: result.rows.map(row => ({ ...row, bucketStart: row.bucketStart! })) };
  }
  async traffic(query: import('./types.js').TrafficQuery) {
    const result = await this.execute(this.sql().traffic(query));
    return { meta: result.meta, rows: result.rows.map(row => ({ bucketStart: numeric(row, 'bucket_start'), armId: text(row, 'arm_id'),
      generation: numeric(row, 'generation'), assignments: numeric(row, 'assignments'), exposures: numeric(row, 'exposures'),
      assignmentShare: row.assignment_share === null ? null : numeric(row, 'assignment_share'), exposureShare: row.exposure_share === null ? null : numeric(row, 'exposure_share') })) };
  }
  async policies(query: import('./types.js').PolicyQuery) {
    const result = await this.execute(this.sql().policies(query));
    return { meta: result.meta, rows: result.rows.map(row => {
      const payload = jsonObject(row, 'payload_json');
      return { occurredAt: numeric(row, 'occurred_at'), recordId: text(row, 'record_id'), armId: text(row, 'arm_id'), generation: numeric(payload, 'generation'),
        probability: numeric(payload, 'probability'), meanReward: payload.meanReward === null ? null : numeric(payload, 'meanReward'), score: payload.score === null ? null : numeric(payload, 'score'), scoreScale: numeric(payload, 'scoreScale'), reason: text(payload, 'reason'), status: text(payload, 'status') };
    }) };
  }
  async attributeKeys(query: import('./types.js').QueryRange): ReturnType<AnalyticsAPI['attributeKeys']> {
    const result = await this.execute(this.sql().attributeKeys(query));
    return { coverage: { basis: 'utc_day', from: Math.floor(query.from / 86_400_000) * 86_400_000, to: Math.ceil(query.to / 86_400_000) * 86_400_000 }, meta: result.meta, rows: result.rows.map(row => {
      const type = text(row, 'attribute_type'), source = text(row, 'attribute_source');
      invariant(type === 'string' || type === 'number' || type === 'boolean' || type === 'null', 'unavailable', 'Invalid attribute type');
      invariant(source === 'event' || source === 'user', 'unavailable', 'Invalid attribute source');
      return { key: text(row, 'attribute_key'), type, source, latestReceivedAt: numeric(row, 'latest_received_at') };
    }) };
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
