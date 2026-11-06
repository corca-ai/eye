/** Automatic goal totals by first server receipt, not occurrence time. Whole UTC hours in [from,to),
 * at most 59 days and inside coverage/finalizedBefore. No configuration or historical backfill. */
export interface HourlyGoalQuery { from: number; to: number; goalId?: string }
/** Unix milliseconds: coverageFrom is the first fully covered UTC hour, finalizedBefore the exclusive
 * readable end (hours close ten minutes after ending), queriedAt the read time, not an ingestion watermark. */
export interface HourlyGoalStatus { coverageFrom: number; finalizedBefore: number; queriedAt: number }
/** Signed totals of accepted goals by server receipt hour; closed buckets never change.
 * Processing after the ten-minute closing deadline is permanently omitted, even if raw logging succeeds.
 * Empty buckets are omitted; uncovered/unfinalized ranges or results over 50,000 rows fail with unavailable. */
export interface HourlyGoalReport {
  rows: { bucketStart: number; goalId: string; events: number; totalValue: number }[];
  meta: HourlyGoalStatus & { basis: 'receipt_hour' };
}
