import type { SummaryConfig, SummaryQuery, SummaryReport, SummaryRow, SummaryStatus } from '../analytics/summaries.js';
import { finite, invariant } from '../core/errors.js';
import { addReward, mergeReward, type RewardSum } from '../core/reward-sum.js';
import { id, record, RETENTION_MS, timestamp } from '../core/validation.js';
import type { Assignment, GoalEvent } from '../core/types.js';
import type { LearningSQL } from './incremental.js';

const HOUR = 3_600_000, MAX_ROWS = 50_000;
const ceilHour = (at: number) => Math.ceil(at / HOUR) * HOUR;
type State = SummaryStatus & { rows: number };
type Bucket = RewardSum & { kind: string; target: string; bucket: number; dimension: string; count: number };
const disabled = (): State => ({ config: { goalIds: [], experimentIds: [] }, state: 'disabled', coverageFrom: null, bucketMs: HOUR, rows: 0 });
function readState(sql: LearningSQL): State {
  const row = sql.exec<{ data: string }>('SELECT data FROM summary_config WHERE id = 1').toArray()[0];
  return row ? JSON.parse(row.data) as State : disabled();
}
const writeState = (sql: LearningSQL, state: State) => sql.exec('INSERT INTO summary_config VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', JSON.stringify(state));
function publicStatus(state: State, now: number): SummaryStatus {
  return { config: state.config, state: state.state, bucketMs: HOUR,
    coverageFrom: state.coverageFrom === null ? null : Math.max(state.coverageFrom, ceilHour(now - RETENTION_MS)) };
}

/** Optional rollups share the learner transaction, not output retries. No cross-request cache. */
export class IncrementalSummaries {
  constructor(private readonly sql: LearningSQL) {
    sql.exec(`CREATE TABLE IF NOT EXISTS summary_config (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS summary_buckets (kind TEXT NOT NULL, target TEXT NOT NULL, bucket INTEGER NOT NULL,
        dimension TEXT NOT NULL, count INTEGER NOT NULL, scale REAL NOT NULL, sum REAL NOT NULL, correction REAL NOT NULL,
        PRIMARY KEY(kind, target, bucket, dimension));
      CREATE INDEX IF NOT EXISTS summary_bucket_time ON summary_buckets(bucket);`);
  }
  configure(input: SummaryConfig, now: number): SummaryStatus {
    const obj = record(input, 'summary configuration');
    invariant(Object.keys(obj).every(key => key === 'goalIds' || key === 'experimentIds'), 'invalid_input', 'Unsupported summary configuration');
    invariant(Array.isArray(obj.goalIds) && Array.isArray(obj.experimentIds) && obj.goalIds.length + obj.experimentIds.length <= 32,
      'invalid_input', 'Summaries support at most 32 configured IDs');
    const config: SummaryConfig = { goalIds: [...new Set(obj.goalIds.map(value => id(value, 'goalId')))].sort(),
      experimentIds: [...new Set(obj.experimentIds.map(value => id(value, 'experimentId')))].sort() };
    const previous = readState(this.sql);
    if (JSON.stringify(previous.config) === JSON.stringify(config)) return publicStatus(previous, now);
    const enabled = config.goalIds.length + config.experimentIds.length > 0;
    const next: State = { config, state: enabled ? 'collecting' : 'disabled', coverageFrom: enabled ? ceilHour(now) : null, bucketMs: HOUR, rows: 0 };
    this.sql.exec('DELETE FROM summary_buckets');
    writeState(this.sql, next);
    return publicStatus(next, now);
  }
  status(now: number): SummaryStatus { return publicStatus(readState(this.sql), now); }
  batch(now: number): SummaryBatch { return new SummaryBatch(this.sql, readState(this.sql), now); }
  query(input: SummaryQuery, now: number): SummaryReport {
    const obj = record(input, 'summary query');
    invariant(obj.kind === 'goals' || obj.kind === 'learning', 'invalid_input', 'Invalid summary kind');
    invariant(Object.keys(obj).every(key => ['kind', 'from', 'to', obj.kind === 'goals' ? 'goalId' : 'experimentId'].includes(key)), 'invalid_input', 'Unsupported summary option');
    const target = id(obj.kind === 'goals' ? obj.goalId : obj.experimentId, 'summary target');
    const from = timestamp(obj.from, 'from'), to = timestamp(obj.to, 'to');
    invariant(from < to && from % HOUR === 0 && to % HOUR === 0 && to <= Math.floor(now / HOUR) * HOUR && to - from <= 59 * 24 * HOUR,
      'invalid_input', 'Summary ranges require whole completed UTC hours, at most 59 days');
    const state = readState(this.sql), status = publicStatus(state, now);
    invariant(status.state === 'collecting' && status.coverageFrom !== null && from >= status.coverageFrom,
      'unavailable', 'Summary range is not fully covered; use raw analytics');
    invariant((obj.kind === 'goals' ? state.config.goalIds : state.config.experimentIds).includes(target), 'unavailable', 'Summary target is not configured');
    const grouped = new Map<string, RewardSum & { count: number }>();
    for (const bucket of this.sql.exec<Bucket>(`SELECT * FROM summary_buckets WHERE kind=? AND target=? AND bucket>=? AND bucket<? ORDER BY bucket,dimension`, obj.kind, target, from, to)) {
      let total = grouped.get(bucket.dimension);
      if (!total) { total = { count: 0, scale: 0, sum: 0, correction: 0 }; grouped.set(bucket.dimension, total); }
      total.count += bucket.count; mergeReward(total, bucket);
    }
    const rows: SummaryRow[] = [];
    for (const [dimension, value] of grouped) {
      const stats = { count: value.count, total: finite((value.sum + value.correction) * value.scale, 'Summary total'),
        mean: finite((value.sum / value.count + value.correction / value.count) * value.scale, 'Summary mean') };
      if (obj.kind === 'goals') rows.push({ kind: 'goals', goalId: target, ...stats });
      else {
        const [armId, generation, observationWindowMs] = JSON.parse(dimension) as [string, number, number];
        rows.push({ kind: 'learning', experimentId: target, armId, generation, observationWindowMs, ...stats });
      }
    }
    return { rows, meta: { basis: 'durable_local', from, to, coverageFrom: status.coverageFrom, bucketMs: HOUR, queriedAt: now } };
  }
  prune(now: number): boolean {
    const rows = this.sql.exec(`DELETE FROM summary_buckets WHERE rowid IN
      (SELECT rowid FROM summary_buckets WHERE bucket < ? LIMIT 1000) RETURNING rowid`, ceilHour(now - RETENTION_MS)).toArray();
    if (rows.length) { const state = readState(this.sql); state.rows -= rows.length; writeState(this.sql, state); }
    return rows.length === 1000;
  }
}

export class SummaryBatch {
  private readonly pending = new Map<string, Bucket & { inserted: boolean }>();
  private changed = false;
  constructor(private readonly sql: LearningSQL, private readonly state: State, private readonly now: number) {}
  goal(event: GoalEvent): void {
    if (this.state.config.goalIds.includes(event.goalId)) this.add('goals', event.goalId, event.occurredAt, '[]', event.value);
  }
  observation(assignment: Assignment, startAt: number, reward: number): void {
    if (this.state.config.experimentIds.includes(assignment.experimentId)) this.add('learning', assignment.experimentId, startAt,
      JSON.stringify([assignment.armId, assignment.generation, assignment.settings.observationWindowMs]), reward);
  }
  private add(kind: string, target: string, at: number, dimension: string, reward: number): void {
    const coverage = this.state.coverageFrom;
    if (this.state.state !== 'collecting' || coverage === null || at < Math.max(coverage, ceilHour(this.now - RETENTION_MS))) return;
    const bucket = Math.floor(at / HOUR) * HOUR, key = JSON.stringify([kind, target, bucket, dimension]);
    let value = this.pending.get(key);
    if (!value) {
      const previous = this.sql.exec<Bucket>('SELECT * FROM summary_buckets WHERE kind=? AND target=? AND bucket=? AND dimension=?', kind, target, bucket, dimension).toArray()[0];
      if (!previous && this.state.rows >= MAX_ROWS) {
        // Never turn optional dimension growth into a failing learning transaction.
        // Coverage is invalid from here; an explicit disable/re-enable starts fresh.
        this.state.state = 'capacity_exceeded'; this.changed = true; this.pending.clear(); return;
      }
      value = previous ? { ...previous, inserted: false } : { kind, target, bucket, dimension, count: 0, scale: 0, sum: 0, correction: 0, inserted: true };
      if (value.inserted) { this.state.rows++; this.changed = true; }
      this.pending.set(key, value);
    }
    value.count++; addReward(value, reward);
  }
  flush(): void {
    for (const value of this.pending.values()) this.sql.exec(`INSERT INTO summary_buckets VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind,target,bucket,dimension) DO UPDATE SET count=excluded.count,scale=excluded.scale,sum=excluded.sum,correction=excluded.correction`,
    value.kind, value.target, value.bucket, value.dimension, value.count, value.scale, value.sum, value.correction);
    if (this.changed) {
      // On capacity failure pending new rows were discarded, so count durable rows once.
      if (this.state.state === 'capacity_exceeded') this.state.rows = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM summary_buckets').toArray()[0]!.n;
      writeState(this.sql, this.state);
    }
  }
}
