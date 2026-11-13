/** Whole-minute boundaries in ascending order, at most 60 days/256 buckets.
 * A caller can supply local midnight boundaries, including DST and half-hour zones.
 * Queries read only durable aggregates; no raw SQL, cache miss work or backfill. */
export interface DashboardQuery { experimentId: string; boundaries: number[] }
/** Cumulative site-wide processing diagnostics since this materialization was installed; not per-experiment errors or an error bound. */
export interface DashboardDiagnostics { staleExposures: number; staleIdentities: number; futureExposures: number; closedGoals: number }
/** Actual processing-order attribution, with the same split, decay and observation eligibility as learning.
 * Rewards include still-open observations; learning rows contain closed observations only.
 * No retroactive correction of inter-batch event disorder. Coverage never implies ingestion completeness. */
export interface DashboardReport {
  rewards: { bucketStart: number; goalId: string; armId: string; generation: number; goals: number; totalValue: number }[];
  traffic: { bucketStart: number; armId: string; generation: number; assignments: number; exposures: number }[];
  learning: { armId: string; generation: number; completed: number; learningValue: number }[];
  policies: { occurredAt: number; armId: string; generation: number; status: string; probability: number; meanReward: number | null; score: number | null; scoreScale: number }[];
  meta: { basis: 'processed_learning'; coverageFrom: number; queriedAt: number; lastProcessedAt: number | null; diagnostics: DashboardDiagnostics };
}
