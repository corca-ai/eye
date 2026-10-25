/** Optional, bounded summaries of durable local acceptance/closure; no raw-store query. */
export interface SummaryConfig {
  /** Combined maximum 32 goal/experiment IDs. Empty lists disable collection. */
  goalIds: string[];
  experimentIds: string[];
}
export interface SummaryStatus {
  config: SummaryConfig;
  state: 'disabled' | 'collecting' | 'capacity_exceeded';
  /** First fully covered UTC hour on goal occurrence / observation start axis. No backfill. */
  coverageFrom: number | null;
  bucketMs: number;
}
export type SummaryQuery = { from: number; to: number } & (
  { kind: 'goals'; goalId: string } | { kind: 'learning'; experimentId: string }
);
export type SummaryRow = { count: number; total: number; mean: number } & (
  { kind: 'goals'; goalId: string } |
  { kind: 'learning'; experimentId: string; armId: string; generation: number; observationWindowMs: number }
);
export interface SummaryReport {
  rows: SummaryRow[];
  meta: {
    basis: 'durable_local'; from: number; to: number; coverageFrom: number; bucketMs: number;
    /** Snapshot read time, NOT a completeness watermark or original receipt time.
     * Late accepted goals and subsequently closed samples may revise older hours. */
    queriedAt: number;
  };
}
export interface SummariesAPI {
  /** Trusted admin route only. Changed configuration resets all summaries; identical retries preserve them.
   * To restart after capacity_exceeded, disable with empty lists, then configure again. */
  configure(config: SummaryConfig): Promise<SummaryStatus>;
  status(): Promise<SummaryStatus>;
  /** Whole UTC hours, at most 59 days, entirely inside coverage and before the current hour.
   * Throws unavailable for missing coverage; use existing raw analytics when needed. */
  query(query: SummaryQuery): Promise<SummaryReport>;
}
