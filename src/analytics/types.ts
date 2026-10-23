export type Scalar = string | number | boolean | null;
export interface AttributeField { key: string; type: 'string' | 'number' | 'boolean' }
export type Filter =
  | { and: readonly Filter[] } | { or: readonly Filter[] } | { not: Filter }
  | { field: AttributeField; op: 'eq' | 'ne'; value: Scalar }
  | { field: AttributeField; op: 'lt' | 'lte' | 'gt' | 'gte'; value: number }
  | { field: AttributeField; op: 'in'; value: readonly Scalar[] }
  | { field: AttributeField; op: 'exists' | 'missing' };
/** All intervals are [from, to), in Unix milliseconds. */
export interface QueryRange { from: number; to: number; limit?: number }
export interface ArmQuery extends QueryRange {
  experimentId: string; armId?: string; generation?: number; goalId?: string; groupBy?: readonly AttributeField[]; filter?: Filter;
  /** Restrict to observations containing a matching track event, without duplicating the denominator. */
  hasEvent?: { name: string; filter?: Filter };
}
export interface TimelineQuery extends QueryRange {
  subject: { cid: string; uid?: never } | { uid: string; cid?: never };
  /** Include anonymous events only inside explicitly known login intervals. Defaults to true. */
  includeLinked?: boolean; cursor?: string;
}
export interface GoalQuery extends QueryRange { goalId?: string; filter?: Filter }
export interface SeriesQuery extends GoalQuery { bucketMs: number }
export interface AttributeValuesQuery extends QueryRange { field: AttributeField; filter?: Filter }
export interface AnalyticsMeta {
  queriedAt: number;
  /** Upper bound on received_at, not an ingestion watermark or an Iceberg snapshot. */
  receivedBefore: number;
  consistency: 'eventual'; truncated: boolean; bytesScanned: number | null;
}
export interface ArmRow {
  armId: string; generation: number; observationWindowMs: number; groups: Scalar[];
  completed: number; pending: number; interrupted: number; subjects: number;
  totalValue: number; meanValue: number | null; latestReceivedAt: number;
}
export interface TimelineRow {
  table: 'events' | 'observations' | 'credits' | 'decisions' | 'identity_links';
  recordId: string; revision: number; occurredAt: number; receivedAt: number;
  cid: string | null; uid: string | null; subjectKey: string;
  experimentId: string | null; armId: string | null; goalId: string | null;
  status: string | null; value: number | null;
  attributes: Record<string, Scalar>; payload: Record<string, unknown>;
}
export interface GoalRow { goalId: string; events: number; totalValue: number; latestReceivedAt: number }
export interface SeriesRow extends GoalRow { bucketStart: number }
export interface AttributeValueRow { value: Scalar; events: number; latestReceivedAt: number }
export interface AnalyticsPage<T> { rows: T[]; meta: AnalyticsMeta }
export interface ArmReport extends AnalyticsPage<ArmRow> { cohortBasis: 'observation_start' }
export interface TimelinePage extends AnalyticsPage<TimelineRow> { nextCursor: string | null }
export interface ArmSeriesQuery extends ArmQuery { bucketMs: number }
export interface ArmSeriesRow extends ArmRow { bucketStart: number }
export interface TrafficQuery extends QueryRange { experimentId: string; bucketMs: number }
export interface TrafficRow { bucketStart: number; armId: string; generation: number; assignments: number; exposures: number; assignmentShare: number | null; exposureShare: number | null }
export interface PolicyQuery extends QueryRange { experimentId: string; armId?: string }
export interface PolicyHistoryRow { occurredAt: number; recordId: string; generation: number; armId: string; probability: number; meanReward: number | null; score: number | null; scoreScale: number; reason: string; status: string }
export interface AttributeKeyRow { key: string; type: 'string' | 'number' | 'boolean' | 'null'; source: 'event' | 'user'; latestReceivedAt: number }
export interface AttributeKeyReport extends AnalyticsPage<AttributeKeyRow> { coverage: { basis: 'utc_day'; from: number; to: number } }
export interface AnalyticsAPI {
  armSeries(query: ArmSeriesQuery): Promise<AnalyticsPage<ArmSeriesRow>>;
  traffic(query: TrafficQuery): Promise<AnalyticsPage<TrafficRow>>;
  policies(query: PolicyQuery): Promise<AnalyticsPage<PolicyHistoryRow>>;
  attributeKeys(query: QueryRange): Promise<AttributeKeyReport>;
  arms(query: ArmQuery): Promise<ArmReport>;
  timeline(query: TimelineQuery): Promise<TimelinePage>;
  goals(query: GoalQuery): Promise<AnalyticsPage<GoalRow>>;
  series(query: SeriesQuery): Promise<AnalyticsPage<SeriesRow>>;
  attributeValues(query: AttributeValuesQuery): Promise<AnalyticsPage<AttributeValueRow>>;
}
