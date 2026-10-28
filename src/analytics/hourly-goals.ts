/** Automatic goal totals on the runtime's first-receipt clock. No configuration or raw SQL. */
export interface HourlyGoalQuery { from: number; to: number; goalId?: string }
/** Automatic collection coverage and the exclusive end of immutable UTC hours. */
export interface HourlyGoalStatus { coverageFrom: number; finalizedBefore: number; queriedAt: number }
/** Signed totals of accepted goals by server receipt hour; closed buckets never change. */
export interface HourlyGoalReport {
  rows: { bucketStart: number; goalId: string; events: number; totalValue: number }[];
  meta: HourlyGoalStatus & { basis: 'receipt_hour' };
}
