import { EyeError, invariant } from '../core/errors.js';
import { AnalyticsSQL } from './sql.js';
import type { Cursor, QueryPlan } from './sql.js';
import { object, numeric, armRow, learningRow, trafficRow, policyRow, attributeKeyRow, timelineRow, eventListRow, eventSeriesRow, goalRow, attributeValueRow, type Row } from './query-rows.js';
import type { EventListPage, AnalyticsAPI, AnalyticsMeta, AnalyticsPage, ArmQuery, ArmReport, AttributeValuesQuery, AttributeValueRow, GoalQuery, GoalRow, SeriesQuery, SeriesRow, EventsQuery, TimelinePage, TimelineQuery, TimelineRow } from './types.js';

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
  async rewardSeries(query: import('./types.js').RewardSeriesQuery): ReturnType<AnalyticsAPI['rewardSeries']> {
    const result = await this.execute(this.sql().rewardSeries(query));
    return {meta: result.meta, rows: result.rows.map(row => {
      invariant(typeof row.arm_id === 'string', 'unavailable', 'Invalid arm ID');
      return {bucketStart: numeric(row, 'bucket_start'), armId: row.arm_id, generation: numeric(row, 'generation'), goals: numeric(row, 'goals'), totalValue: numeric(row, 'total_value'), latestReceivedAt: numeric(row, 'latest_received_at')};
    })};
  }
  async arms(query: ArmQuery): Promise<ArmReport> {
    const result = await this.execute(this.sql().arms(query));
    return { rewardBasis: 'raw_attribution', cohortBasis: 'observation_start',
      meta: result.meta, rows: result.rows.map(row => armRow(row, query.groupBy ?? [])) };
  }
  async learning(query: import('./types.js').LearningQuery): Promise<import('./types.js').LearningReport> {
    const result = await this.execute(this.sql().learning(query));
    return { allocationMode: 'all', rewardBasis: 'closed_learning', cohortBasis: 'observation_start', meta: result.meta, rows: result.rows.map(learningRow) };
  }
  async armSeries(query: import('./types.js').ArmSeriesQuery) {
    invariant(Number.isSafeInteger(query.bucketMs) && query.bucketMs > 0, 'invalid_input', 'bucketMs must be positive integer milliseconds');
    const result = await this.execute(this.sql().arms(query, query.bucketMs));
    return { rewardBasis: 'raw_attribution' as const, cohortBasis: 'observation_start' as const, meta: result.meta,
      rows: result.rows.map(row => ({ bucketStart: numeric(row, 'bucket_start'), ...armRow(row, query.groupBy ?? []) })) };
  }
  async traffic(query: import('./types.js').TrafficQuery) {
    const result = await this.execute(this.sql().traffic(query));
    return { meta: result.meta, rows: result.rows.map(trafficRow) };
  }
  async policies(query: import('./types.js').PolicyQuery) {
    const result = await this.execute(this.sql().policies(query));
    return { meta: result.meta, rows: result.rows.map(policyRow) };
  }
  async attributeKeys(query: import('./types.js').QueryRange): ReturnType<AnalyticsAPI['attributeKeys']> {
    const result = await this.execute(this.sql().attributeKeys(query));
    return { coverage: { basis: 'utc_day', from: Math.floor(query.from / 86_400_000) * 86_400_000, to: Math.ceil(query.to / 86_400_000) * 86_400_000 }, meta: result.meta, rows: result.rows.map(attributeKeyRow) };
  }
  async timeline(query: TimelineQuery): Promise<TimelinePage> {
    return this.eventPage(this.sql().timeline(query), timelineRow, row => row.table);
  }
  async events(query: EventsQuery): Promise<TimelinePage> { return this.eventPage(this.sql().events(query), timelineRow, row => row.table); }
  async eventList(query: EventsQuery): Promise<EventListPage> {
    return this.eventPage(this.sql().events(query, true), eventListRow, () => 'events');
  }
  private async eventPage<T extends Pick<TimelineRow, 'recordId' | 'occurredAt'>>(
    plan: QueryPlan, decode: (row: Row) => T, table: (row: T) => Cursor['table'],
  ): Promise<AnalyticsPage<T> & { nextCursor: string | null }> {
    const result = await this.execute(plan), rows = result.rows.map(decode), last = rows.at(-1);
    const cursor: Cursor | null = result.meta.truncated && last ? {
      fingerprint: plan.fingerprint, receivedBefore: plan.receivedBefore,
      at: last.occurredAt, table: table(last), id: last.recordId,
    } : null;
    return { rows, meta: result.meta, nextCursor: cursor ? JSON.stringify(cursor) : null };
  }
  async goals(query: GoalQuery): Promise<AnalyticsPage<GoalRow>> {
    const result = await this.execute(this.sql().goals(query)); return { meta: result.meta, rows: result.rows.map(goalRow) };
  }
  async eventSeries(query: import('./types.js').EventSeriesQuery): Promise<import('./types.js').EventSeriesPage> {
    const result = await this.execute(this.sql().eventSeries(query));
    invariant(!result.meta.truncated, 'unavailable', 'Event series exceeded its bucket budget');
    return { meta: { ...result.meta, cacheHit: false, cacheExpiresAt: result.meta.queriedAt },
      rows: result.rows.map(eventSeriesRow) };
  }
  async series(query: SeriesQuery): Promise<AnalyticsPage<SeriesRow>> {
    const result = await this.execute(this.sql().series(query)); return { meta: result.meta, rows: result.rows.map(row => ({ ...goalRow(row), bucketStart: numeric(row, 'bucket_start') })) };
  }
  async attributeValues(query: AttributeValuesQuery): Promise<AnalyticsPage<AttributeValueRow>> {
    const result = await this.execute(this.sql().attributeValues(query));
    return { meta: result.meta, rows: result.rows.map(attributeValueRow) };
  }
}
