import type { HourlyGoalQuery, HourlyGoalReport, HourlyGoalStatus } from '../analytics/hourly-goals.js';
import { invariant, finite } from '../core/errors.js';
import { addReward, type RewardSum } from '../core/reward-sum.js';
import { id, record, timestamp, RETENTION_MS } from '../core/validation.js';
import type { GoalEvent } from '../core/types.js';
import type { LearningSQL } from './incremental.js';

const HOUR = 3_600_000, FINALIZE_DELAY = 10 * 60_000;
const ceilHour = (at: number) => Math.ceil(at / HOUR) * HOUR;
export const finalizedHour = (now: number): number => Math.floor((now - FINALIZE_DELAY) / HOUR) * HOUR;
type Bucket = RewardSum & { bucket: number; goal_id: string; events: number };

/** Writes share learning's deduplication transaction. Time itself seals buckets; no finalizer jobs. */
export class HourlyGoals {
  constructor(private readonly sql: LearningSQL, now = Date.now()) {
    sql.exec(`CREATE TABLE IF NOT EXISTS hourly_goal_state (id INTEGER PRIMARY KEY CHECK(id=1), coverage_from INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hourly_goals (bucket INTEGER NOT NULL, goal_id TEXT NOT NULL,
        events INTEGER NOT NULL, scale REAL NOT NULL, sum REAL NOT NULL, correction REAL NOT NULL,
        PRIMARY KEY(bucket,goal_id));`);
    sql.exec('INSERT OR IGNORE INTO hourly_goal_state VALUES (1, ?)', ceilHour(now));
  }
  private coverage(now: number): number {
    const start = this.sql.exec<{ coverage_from: number }>('SELECT coverage_from FROM hourly_goal_state WHERE id=1').toArray()[0]!.coverage_from;
    return Math.max(start, ceilHour(now - RETENTION_MS));
  }
  batch(now: number): HourlyGoalBatch { return new HourlyGoalBatch(this.sql, this.coverage(now), finalizedHour(now)); }
  status(now: number): HourlyGoalStatus {
    return { coverageFrom: this.coverage(now), finalizedBefore: finalizedHour(now), queriedAt: now };
  }
  query(input: HourlyGoalQuery, now: number): HourlyGoalReport {
    const obj = record(input, 'hourly goal query');
    invariant(Object.keys(obj).every(key => key === 'from' || key === 'to' || key === 'goalId'), 'invalid_input', 'Unsupported hourly goal query');
    const from = timestamp(obj.from, 'from'), to = timestamp(obj.to, 'to');
    const goalId = obj.goalId === undefined ? undefined : id(obj.goalId, 'goalId');
    const finalizedBefore = finalizedHour(now), coverageFrom = this.coverage(now);
    invariant(from < to && from % HOUR === 0 && to % HOUR === 0 && to - from <= 59 * 24 * HOUR,
      'invalid_input', 'Hourly goals require whole UTC hours, at most 59 days');
    invariant(from >= coverageFrom && to <= finalizedBefore, 'unavailable', 'Hourly goal range is not fully covered or finalized');
    const rows = this.sql.exec<Bucket>(`SELECT * FROM hourly_goals WHERE bucket>=? AND bucket<?${goalId === undefined ? '' : ' AND goal_id=?'} ORDER BY bucket,goal_id LIMIT 50001`,
      from, to, ...(goalId === undefined ? [] : [goalId])).toArray();
    invariant(rows.length <= 50_000, 'unavailable', 'Hourly goal result exceeds its row budget; narrow the range');
    return { rows: rows.map(row => ({ bucketStart: row.bucket, goalId: row.goal_id, events: row.events,
      totalValue: finite((row.sum + row.correction) * row.scale, 'Hourly goal total') })),
    meta: { basis: 'receipt_hour', coverageFrom, finalizedBefore, queriedAt: now } };
  }
  prune(now: number): boolean {
    return this.sql.exec(`DELETE FROM hourly_goals WHERE rowid IN
      (SELECT rowid FROM hourly_goals WHERE bucket<? LIMIT 1000) RETURNING rowid`, ceilHour(now - RETENTION_MS)).toArray().length === 1000;
  }
}

/** One learning transaction; discard this accumulator if the transaction rolls back. */
export class HourlyGoalBatch {
  private readonly pending = new Map<string, Bucket>();
  constructor(private readonly sql: LearningSQL, private readonly coverage: number, private readonly finalized: number) {}
  add(event: GoalEvent, receivedAt: number): void {
    const bucket = Math.floor(receivedAt / HOUR) * HOUR;
    if (bucket < this.coverage || bucket < this.finalized) return;
    const key = JSON.stringify([bucket, event.goalId]);
    let row = this.pending.get(key);
    if (!row) {
      row = this.sql.exec<Bucket>('SELECT * FROM hourly_goals WHERE bucket=? AND goal_id=?', bucket, event.goalId).toArray()[0]
        ?? { bucket, goal_id: event.goalId, events: 0, scale: 0, sum: 0, correction: 0 };
      this.pending.set(key, row);
    }
    row.events++; addReward(row, event.value);
  }
  flush(): void {
    for (const row of this.pending.values()) this.sql.exec(`INSERT INTO hourly_goals VALUES (?,?,?,?,?,?) ON CONFLICT(bucket,goal_id) DO UPDATE SET
      events=excluded.events,scale=excluded.scale,sum=excluded.sum,correction=excluded.correction`,
      row.bucket, row.goal_id, row.events, row.scale, row.sum, row.correction);
  }
}
