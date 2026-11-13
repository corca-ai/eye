import type { DashboardDiagnostics, DashboardQuery, DashboardReport } from '../analytics/dashboard.js';
import { addReward, mergeReward, type RewardSum } from '../core/reward-sum.js';
import { invariant, finite } from '../core/errors.js';
import { id, record, timestamp, RETENTION_MS } from '../core/validation.js';
import type { Assignment, ExposureEvent, GoalEvent } from '../core/types.js';
import type { PublishedPolicy } from '../transport.js';
import type { LearningSQL } from './incremental.js';

const MINUTE = 60_000, MAX_BUCKETS = 500_000, PAGE = 1000;
const ceilMinute = (at: number) => Math.ceil(at / MINUTE) * MINUTE;
type Bucket = RewardSum & { kind: string; target: string; bucket: number; dimension: string; count: number };
type State = { coverage_from: number; rows: number; last_processed_at: number | null; diagnostics: string };
const emptyDiagnostics = (): DashboardDiagnostics => ({staleExposures: 0, staleIdentities: 0, futureExposures: 0, closedGoals: 0});

/** Identifier-free materializations, owned by the same transaction as learning. */
export class Dashboard {
  constructor(private readonly sql: LearningSQL, now: number) {
    sql.exec(`CREATE TABLE IF NOT EXISTS dashboard_state (id INTEGER PRIMARY KEY CHECK(id=1), coverage_from INTEGER NOT NULL, rows INTEGER NOT NULL, last_processed_at INTEGER, diagnostics TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dashboard_buckets (kind TEXT NOT NULL, target TEXT NOT NULL, bucket INTEGER NOT NULL, dimension TEXT NOT NULL, count INTEGER NOT NULL, scale REAL NOT NULL, sum REAL NOT NULL, correction REAL NOT NULL, PRIMARY KEY(kind,target,bucket,dimension));
      CREATE INDEX IF NOT EXISTS dashboard_bucket_time ON dashboard_buckets(bucket);
      CREATE INDEX IF NOT EXISTS dashboard_target_time ON dashboard_buckets(target,bucket);
      CREATE TABLE IF NOT EXISTS dashboard_seen (kind TEXT NOT NULL, event_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, PRIMARY KEY(kind,event_id));
      CREATE INDEX IF NOT EXISTS dashboard_seen_time ON dashboard_seen(occurred_at);
      CREATE TABLE IF NOT EXISTS dashboard_policies (experiment_id TEXT NOT NULL, sequence INTEGER NOT NULL, occurred_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(experiment_id,sequence));
      CREATE INDEX IF NOT EXISTS dashboard_policy_time ON dashboard_policies(occurred_at);`);
    sql.exec('INSERT OR IGNORE INTO dashboard_state VALUES (1,?,0,NULL,?)', ceilMinute(now), JSON.stringify(emptyDiagnostics()));
  }
  private state(): State { return this.sql.exec<State>('SELECT * FROM dashboard_state WHERE id=1').toArray()[0]!; }
  coverage(now: number): number { return Math.max(this.state().coverage_from, ceilMinute(now - RETENTION_MS)); }
  batch(now: number): DashboardBatch { return new DashboardBatch(this.sql, this.coverage(now)); }
  progress(now: number, diagnostics: DashboardDiagnostics): void {
    const previous: DashboardDiagnostics = JSON.parse(this.state().diagnostics);
    for (const key of Object.keys(previous) as (keyof DashboardDiagnostics)[]) previous[key] += diagnostics[key];
    this.sql.exec('UPDATE dashboard_state SET last_processed_at=?,diagnostics=? WHERE id=1', now, JSON.stringify(previous));
  }
  static recordPolicy(sql: LearningSQL, policy: PublishedPolicy, arms: readonly {armId: string; status: string}[]): void {
    const coverage = sql.exec<{coverage_from: number}>('SELECT coverage_from FROM dashboard_state WHERE id=1').toArray()[0]!.coverage_from;
    if (policy.publishedAt < coverage) return;
    const rows = arms.map(arm => {
      const value = policy.arms.find(row => row.armId === arm.armId);
      return { occurredAt: policy.publishedAt, armId: arm.armId, generation: policy.generation,
        status: policy.status === 'active' ? arm.status : policy.status, probability: value?.probability ?? 0,
        meanReward: value?.meanReward ?? null, score: value?.score ?? null, scoreScale: policy.scoreScale };
    });
    sql.exec('INSERT OR IGNORE INTO dashboard_policies VALUES (?,?,?,?)', policy.experimentId, policy.sequence, policy.publishedAt, JSON.stringify(rows));
    const expiry = Math.floor(policy.publishedAt / MINUTE) * MINUTE + RETENTION_MS + 1;
    sql.exec('UPDATE learning_retention SET at=? WHERE id=1 AND (at IS NULL OR at>?)', expiry, expiry);
  }
  query(input: DashboardQuery, now: number): DashboardReport {
    const obj = record(input, 'dashboard query');
    invariant(Object.keys(obj).every(key => key === 'experimentId' || key === 'boundaries'), 'invalid_input', 'Unsupported dashboard query');
    const experimentId = id(obj.experimentId, 'experimentId');
    invariant(Array.isArray(obj.boundaries) && obj.boundaries.length >= 2 && obj.boundaries.length <= 257, 'invalid_input', 'Supply 2..257 dashboard boundaries');
    const boundaries = Array.from(obj.boundaries, value => timestamp(value, 'boundary'));
    invariant(boundaries.every((at, index) => at % MINUTE === 0 && (index === 0 || at > boundaries[index - 1]!)), 'invalid_input', 'Dashboard boundaries must be ascending whole minutes');
    const from = boundaries[0]!, to = boundaries.at(-1)!;
    invariant(to <= now && to - from <= 59 * 86_400_000, 'invalid_input', 'Dashboard range must be in the past, at most 59 days');
    const coverage = this.coverage(now), state = this.state();
    const result: DashboardReport = { rewards: [], traffic: [], learning: [], policies: [],
      meta: {basis: 'processed_learning', coverageFrom: coverage, queriedAt: now, lastProcessedAt: state.last_processed_at, diagnostics: JSON.parse(state.diagnostics)} };
    // Read only compact rows for this experiment; refuse oversized replies rather than silently truncating.
    const groups = new Map<string, Bucket>();
    const bucketAt = (at: number) => {
      let low = 0, high = boundaries.length - 1;
      while (low + 1 < high) { const mid = (low + high) >>> 1; if (boundaries[mid]! <= at) low = mid; else high = mid; }
      return boundaries[low]!;
    };
    for (const row of this.sql.exec<Bucket>('SELECT * FROM dashboard_buckets WHERE target=? AND bucket>=? AND bucket<? ORDER BY bucket', experimentId, Math.max(from, coverage), to)) {
      const at = row.kind === 'learning' ? from : bucketAt(row.bucket), key = JSON.stringify([row.kind, at, row.dimension]);
      let total = groups.get(key);
      if (!total) { total = {...row, bucket: at, count: 0, scale: 0, sum: 0, correction: 0}; groups.set(key, total); }
      invariant(groups.size <= 50_000, 'unavailable', 'Dashboard result exceeds its cell budget; narrow the range');
      total.count += row.count; mergeReward(total, row);
    }
    const trafficGroups = new Map<string, DashboardReport['traffic'][number]>();
    for (const row of groups.values()) {
      const [armId, generation, goalId] = JSON.parse(row.dimension) as [string, number, string];
      const value = finite((row.sum + row.correction) * row.scale, 'Dashboard total');
      if (row.kind === 'reward') result.rewards.push({bucketStart: row.bucket, armId, generation, goalId, goals: row.count, totalValue: value});
      else if (row.kind === 'learning') result.learning.push({armId, generation, completed: row.count, learningValue: value});
      else {
        const key = JSON.stringify([row.bucket, armId, generation]);
        let traffic = trafficGroups.get(key);
        if (!traffic) { traffic = {bucketStart: row.bucket, armId, generation, assignments: 0, exposures: 0}; result.traffic.push(traffic); trafficGroups.set(key, traffic); }
        if (row.kind === 'exposure') traffic.exposures += row.count; else traffic.assignments += row.count;
      }
    }
    const policies = this.sql.exec<{data: string}>('SELECT data FROM dashboard_policies WHERE experiment_id=? AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at LIMIT 5001', experimentId, Math.max(from, coverage), to).toArray();
    invariant(policies.length <= 5000, 'unavailable', 'Policy history exceeds its row budget; narrow the range');
    for (const policy of policies) result.policies.push(...JSON.parse(policy.data) as DashboardReport['policies']);
    invariant(result.policies.length <= 50_000, 'unavailable', 'Policy history exceeds its cell budget; narrow the range');
    return result;
  }
  prune(now: number): boolean {
    const cutoff = ceilMinute(now - RETENTION_MS);
    const removed = this.sql.exec('DELETE FROM dashboard_buckets WHERE rowid IN (SELECT rowid FROM dashboard_buckets WHERE bucket<? LIMIT ?) RETURNING bucket', cutoff, PAGE).toArray();
    this.sql.exec('UPDATE dashboard_state SET rows=rows-? WHERE id=1', removed.length);
    const seen = this.sql.exec('DELETE FROM dashboard_seen WHERE rowid IN (SELECT rowid FROM dashboard_seen WHERE occurred_at<? LIMIT ?) RETURNING rowid', cutoff, PAGE).toArray();
    const policies = this.sql.exec('DELETE FROM dashboard_policies WHERE rowid IN (SELECT rowid FROM dashboard_policies WHERE occurred_at<? LIMIT ?) RETURNING rowid', cutoff, PAGE).toArray();
    return removed.length === PAGE || seen.length === PAGE || policies.length === PAGE;
  }
}

export class DashboardBatch {
  private readonly pending = new Map<string, Bucket>();
  constructor(private readonly sql: LearningSQL, private readonly coverage: number) {}
  private add(kind: string, target: string, at: number, dimension: string, value: number): void {
    if (at < this.coverage) return;
    const bucket = Math.floor(at / MINUTE) * MINUTE, key = JSON.stringify([kind, target, bucket, dimension]);
    let row = this.pending.get(key);
    if (!row) { row = this.sql.exec<Bucket>('SELECT * FROM dashboard_buckets WHERE kind=? AND target=? AND bucket=? AND dimension=?', kind, target, bucket, dimension).toArray()[0]
      ?? {kind, target, bucket, dimension, count: 0, scale: 0, sum: 0, correction: 0}; this.pending.set(key, row); }
    row.count++; addReward(row, value);
  }
  exposure(event: ExposureEvent): void {
    const a = event.assignment, dimension = JSON.stringify([a.armId, a.generation]);
    for (const [kind, key, at] of [['exposure', event.eventId, event.occurredAt], ['assignment', a.assignmentId, a.assignedAt]] as const) {
      if (at < this.coverage) continue;
      const inserted = this.sql.exec('INSERT OR IGNORE INTO dashboard_seen VALUES (?,?,?) RETURNING event_id', kind, key, at).toArray();
      if (inserted.length) this.add(kind, a.experimentId, at, dimension, 0);
    }
  }
  reward(goal: GoalEvent, a: Pick<Assignment, 'experimentId' | 'armId' | 'generation'>, value: number): void {
    this.add('reward', a.experimentId, goal.occurredAt, JSON.stringify([a.armId, a.generation, goal.goalId]), value);
  }
  observation(a: Assignment, startAt: number, reward: number): void {
    this.add('learning', a.experimentId, startAt, JSON.stringify([a.armId, a.generation]), reward);
  }
  flush(): void {
    let inserted = 0;
    for (const row of this.pending.values()) {
      inserted += this.sql.exec(`INSERT OR IGNORE INTO dashboard_buckets VALUES (?,?,?,?,?,?,?,?) RETURNING bucket`, row.kind, row.target, row.bucket, row.dimension, row.count, row.scale, row.sum, row.correction).toArray().length;
      this.sql.exec('UPDATE dashboard_buckets SET count=?,scale=?,sum=?,correction=? WHERE kind=? AND target=? AND bucket=? AND dimension=?', row.count, row.scale, row.sum, row.correction, row.kind, row.target, row.bucket, row.dimension);
    }
    this.sql.exec('UPDATE dashboard_state SET rows=rows+? WHERE id=1', inserted);
    const count = this.sql.exec<{rows: number}>('SELECT rows FROM dashboard_state WHERE id=1').toArray()[0]!.rows;
    if (count > MAX_BUCKETS) {
      const removed = this.sql.exec<{bucket: number}>('DELETE FROM dashboard_buckets WHERE rowid IN (SELECT rowid FROM dashboard_buckets ORDER BY bucket LIMIT ?) RETURNING bucket', Math.max(PAGE, count - MAX_BUCKETS)).toArray();
      // Eviction always advances coverage past the complete affected minute.
      this.sql.exec('UPDATE dashboard_state SET rows=rows-?,coverage_from=MAX(coverage_from,?) WHERE id=1', removed.length, Math.max(...removed.map(row => row.bucket)) + MINUTE);
    }
  }
}
