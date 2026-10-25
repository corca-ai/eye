import { compareEvents } from '../core/attribution.js';
import { closedSampleMoments, type ClosedSample, type ClosedCohort } from '../core/closed-cohort.js';
import { finite, invariant } from '../core/errors.js';
import { decayFactor } from '../core/moments.js';
import { addReward, type RewardSum } from '../core/reward-sum.js';
import type { ExposureEvent, EyeEvent, GoalEvent, IdentityEvent } from '../core/types.js';
import { RETENTION_MS, subjectKey } from '../core/validation.js';
import { analyticsRecord, type AnalyticsRecord } from '../analytics/records.js';

type SampleEvent = ExposureEvent & { sample: NonNullable<ExposureEvent['sample']>; attributionWindowMs: number };
type SampleRow = RewardSum & { sample_id: string; data: string; definition: string; close_at: number };
export interface LearningOutput {
  cohort: Pick<ClosedCohort, 'cohortId' | 'asOf' | 'arms'>;
  records: AnalyticsRecord[];
}
export interface LearningDiagnostics { staleExposures: number; staleIdentities: number; futureExposures: number; closedGoals: number }
export interface LearningReceipt { accepted: boolean[]; diagnostics: LearningDiagnostics }
const encoder = new TextEncoder();
const ownerKey = (kind: 'cid' | 'uid', key: string) => JSON.stringify([kind, key]);
const decode = <T>(value: string): T => JSON.parse(value) as T;
const CLOSE_LIMIT = 500;
const CLOSE_BYTES = 512_000;
type Value = string | number | null;
/** The synchronous SQL operations shared by workerd and the local SQLite experiment. */
export interface LearningSQL {
  exec<T extends Record<string, Value>>(query: string, ...bindings: Value[]): Iterable<T> & { toArray(): T[] };
}

/** Synchronous durable state. The caller wraps accept/close in transactionSync.
 * Only the received batch is sorted; there is no global reorder buffer or replay.
 */
export class IncrementalLearning {
  constructor(private readonly sql: LearningSQL) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS learning_seen (event_id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL, accepted INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS learning_seen_time ON learning_seen(occurred_at);
      CREATE TABLE IF NOT EXISTS learning_identity (cid TEXT PRIMARY KEY, uid TEXT, occurred_at INTEGER NOT NULL, event_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS learning_identity_time ON learning_identity(occurred_at);
      CREATE TABLE IF NOT EXISTS learning_last (owner TEXT NOT NULL, experiment_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner, experiment_id));
      CREATE INDEX IF NOT EXISTS learning_last_time ON learning_last(occurred_at);
      CREATE TABLE IF NOT EXISTS learning_samples (sample_id TEXT PRIMARY KEY, close_at INTEGER NOT NULL, data TEXT NOT NULL, definition TEXT NOT NULL, scale REAL NOT NULL, sum REAL NOT NULL, correction REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS learning_samples_close ON learning_samples(close_at, sample_id);
      CREATE TABLE IF NOT EXISTS learning_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
    `);
  }
  accept(events: readonly EyeEvent[], now: number, goalActive: (goal: GoalEvent) => boolean = () => true): LearningReceipt {
    const diagnostics: LearningDiagnostics = { staleExposures: 0, staleIdentities: 0, futureExposures: 0, closedGoals: 0 };
    const accepted = events.map(() => true);
    for (const { event, index } of events.map((event, index) => ({ event, index })).sort((a, b) => compareEvents(a.event, b.event))) {
      if (event.kind === 'track') continue;
      const status = event.kind !== 'goal' || goalActive(event);
      const inserted = this.sql.exec<{ accepted: number }>('INSERT OR IGNORE INTO learning_seen VALUES (?, ?, ?) RETURNING accepted', event.eventId, event.occurredAt, Number(status)).toArray();
      if (inserted.length === 0) {
        accepted[index] = this.sql.exec<{ accepted: number }>('SELECT accepted FROM learning_seen WHERE event_id = ?', event.eventId).toArray()[0]!.accepted === 1;
        continue;
      }
      accepted[index] = status;
      if (!status) continue;
      if (event.kind === 'identify' || event.kind === 'logout') this.identity(event, diagnostics);
      else if (event.kind === 'exposure') this.exposure(event, now, diagnostics);
      else if (event.kind === 'goal') this.goal(event, now, diagnostics);
    }
    return { accepted, diagnostics };
  }
  private identity(event: IdentityEvent, diagnostics: LearningDiagnostics): void {
    const { cid } = event.subject;
    const current = this.sql.exec<{ uid: string | null; occurred_at: number; event_id: string }>(
      'SELECT uid, occurred_at, event_id FROM learning_identity WHERE cid = ?', cid).toArray()[0];
    if (current && compareEvents({ occurredAt: current.occurred_at, eventId: current.event_id }, event) > 0) {
      diagnostics.staleIdentities++; return;
    }
    const anonymous = ownerKey('cid', cid);
    if (event.kind === 'identify') {
      const uid = event.subject.uid!;
      if (current?.uid !== uid) {
        if (current?.uid == null) for (const row of this.sql.exec<{ data: string }>('SELECT data FROM learning_last WHERE owner = ?', anonymous))
          this.putLast(ownerKey('uid', uid), decode<SampleEvent>(row.data), diagnostics);
        this.sql.exec('DELETE FROM learning_last WHERE owner = ?', anonymous);
      }
    } else this.sql.exec('DELETE FROM learning_last WHERE owner = ?', anonymous);
    this.sql.exec(`INSERT INTO learning_identity VALUES (?, ?, ?, ?) ON CONFLICT(cid) DO UPDATE SET
      uid = excluded.uid, occurred_at = excluded.occurred_at, event_id = excluded.event_id`,
    cid, event.kind === 'identify' ? event.subject.uid! : null, event.occurredAt, event.eventId);
  }
  private exposure(event: ExposureEvent, now: number, diagnostics: LearningDiagnostics): void {
    invariant(event.sample && event.attributionWindowMs, 'invalid_input', 'Exposure needs local sample context');
    const exposure = event as SampleEvent;
    const sampleId = exposure.sample.sampleId;
    const closeAt = exposure.sample.startAt + exposure.assignment.settings.observationWindowMs + exposure.assignment.settings.allowedLatenessMs;
    const definition = JSON.stringify([exposure.assignment, exposure.sample.startAt, exposure.attributionWindowMs]);
    if (closeAt > now) {
      const old = this.sql.exec<SampleRow>('SELECT * FROM learning_samples WHERE sample_id = ?', sampleId).toArray()[0];
      if (!old) this.sql.exec('INSERT INTO learning_samples VALUES (?, ?, ?, ?, 0, 0, 0)', sampleId, closeAt, JSON.stringify(exposure), definition);
      else {
        invariant(old.definition === definition, 'conflict', 'Conflicting sample context');
        if (compareEvents(exposure, decode<SampleEvent>(old.data)) < 0)
          this.sql.exec('UPDATE learning_samples SET data = ? WHERE sample_id = ?', JSON.stringify(exposure), sampleId);
      }
    }
    if (exposure.subject.uid !== undefined) this.putLast(ownerKey('uid', exposure.subject.uid), exposure, diagnostics);
    else {
      const identity = this.sql.exec<{ uid: string | null }>('SELECT uid FROM learning_identity WHERE cid = ?', exposure.subject.cid).toArray()[0];
      if (identity?.uid == null) this.putLast(ownerKey('cid', exposure.subject.cid), exposure, diagnostics);
    }
  }
  private putLast(owner: string, event: SampleEvent, diagnostics: LearningDiagnostics): void {
    const previous = this.sql.exec<{ data: string }>('SELECT data FROM learning_last WHERE owner = ? AND experiment_id = ?', owner, event.assignment.experimentId).toArray()[0];
    if (previous && compareEvents(decode<SampleEvent>(previous.data), event) >= 0) { diagnostics.staleExposures++; return; }
    this.sql.exec(`INSERT INTO learning_last VALUES (?, ?, ?, ?) ON CONFLICT(owner, experiment_id) DO UPDATE SET
      occurred_at = excluded.occurred_at, data = excluded.data`, owner, event.assignment.experimentId, event.occurredAt, JSON.stringify(event));
  }
  private goal(goal: GoalEvent, now: number, diagnostics: LearningDiagnostics): void {
    const owner = goal.subject.uid === undefined ? ownerKey('cid', goal.subject.cid) : ownerKey('uid', goal.subject.uid);
    const eligible: SampleEvent[] = [];
    for (const row of this.sql.exec<{ data: string }>('SELECT data FROM learning_last WHERE owner = ?', owner)) {
      const event = decode<SampleEvent>(row.data);
      if (compareEvents(event, goal) > 0) { diagnostics.futureExposures++; continue; }
      if (goal.occurredAt - event.occurredAt <= event.attributionWindowMs) eligible.push(event);
    }
    for (const event of eligible) {
      const sample = this.sql.exec<SampleRow>('SELECT * FROM learning_samples WHERE sample_id = ?', event.sample.sampleId).toArray()[0];
      const endAt = event.sample.startAt + event.assignment.settings.observationWindowMs;
      if (!sample || sample.close_at <= now) { diagnostics.closedGoals++; continue; }
      if (goal.occurredAt < event.sample.startAt || goal.occurredAt >= endAt) continue;
      const baseValue = goal.value / eligible.length;
      const factor = decayFactor(goal.occurredAt - event.occurredAt, event.assignment.settings.attributionHalfLifeMs);
      const value = baseValue * factor;
      addReward(sample, value);
      this.sql.exec('UPDATE learning_samples SET scale = ?, sum = ?, correction = ? WHERE sample_id = ?', sample.scale, sample.sum, sample.correction, sample.sample_id);

    }
  }
  /** Freeze a bounded set of zero/nonzero completed samples and remove them in the same transaction. */
  close(siteId: string, now: number): number {
    const rows = this.sql.exec<SampleRow>('SELECT * FROM learning_samples WHERE close_at <= ? ORDER BY close_at, sample_id LIMIT ?', now, CLOSE_LIMIT);
    const records: AnalyticsRecord[] = [], samples: ClosedSample[] = [];
    let bytes = 0;
    for (const row of rows) {
      const event = decode<SampleEvent>(row.data), a = event.assignment;
      const reward = finite((row.sum + row.correction) * row.scale, 'Sample reward');
      const endAt = event.sample.startAt + a.settings.observationWindowMs;
      const record = analyticsRecord({ siteId, subjectKey: subjectKey(siteId, event.subject), ...event.subject },
        'observations', row.sample_id, 2, event.sample.startAt, now,
        { sampleId: row.sample_id, assignment: a, startAt: event.sample.startAt, endAt, reward,
          observationId: row.sample_id, assignmentId: a.assignmentId, experimentId: a.experimentId,
          armId: a.armId, generation: a.generation, closeAt: row.close_at, status: 'complete', learningClosed: true },
        { experiment_id: a.experimentId, arm_id: a.armId, assignment_id: a.assignmentId,
          observation_id: row.sample_id, status: 'complete', value: reward }, event.userAttributes);
      const size = encoder.encode(JSON.stringify(record)).byteLength;
      if (records.length && bytes + size > CLOSE_BYTES) break;
      bytes += size; records.push(record);
      samples.push({ sampleId: row.sample_id, assignment: a, startAt: event.sample.startAt, endAt, reward });
    }
    for (let offset = 0; offset < samples.length; offset += 100) {
      const ids = samples.slice(offset, offset + 100).map(sample => sample.sampleId);
      this.sql.exec(`DELETE FROM learning_samples WHERE sample_id IN (${ids.map(() => '?').join(',')})`, ...ids);
    }
    if (records.length) this.enqueue({ cohort: { cohortId: crypto.randomUUID(), asOf: now, arms: closedSampleMoments(samples, now) }, records });
    return records.length;
  }
  private enqueue(output: LearningOutput): void { this.sql.exec('INSERT INTO learning_outbox(data) VALUES (?)', JSON.stringify(output)); }
  outputs(): { id: number; output: LearningOutput }[] {
    return this.sql.exec<{ id: number; data: string }>('SELECT id, data FROM learning_outbox ORDER BY id LIMIT 20').toArray()
      .map(row => ({ id: row.id, output: decode<LearningOutput>(row.data) }));
  }
  acknowledge(ids: number[]): void {
    if (ids.length) this.sql.exec(`DELETE FROM learning_outbox WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  }
  nextWake(now: number): number | null {
    if (this.sql.exec('SELECT id FROM learning_outbox LIMIT 1').toArray().length) return now + 1000;
    const close = this.sql.exec<{ at: number | null }>('SELECT MIN(close_at) AS at FROM learning_samples').toArray()[0]!.at;
    const first = this.sql.exec<{ at: number | null }>(`SELECT MIN(at) AS at FROM (
      SELECT MIN(occurred_at) AS at FROM learning_seen UNION ALL
      SELECT MIN(occurred_at) AS at FROM learning_identity UNION ALL
      SELECT MIN(occurred_at) AS at FROM learning_last)`).toArray()[0]!.at;
    const dates = [close, first === null ? null : first + RETENTION_MS + 1].filter((at): at is number => at !== null);
    return dates.length ? Math.max(now + 1000, Math.min(...dates)) : null;
  }
  /** At most a bounded number of expired rows per table per alarm. */
  prune(now: number): boolean {
    let more = false;
    for (const [table, key] of [['learning_seen', 'event_id'], ['learning_identity', 'cid'], ['learning_last', 'rowid']] as const) {
      const removed = this.sql.exec(`DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE occurred_at < ? LIMIT 1000) RETURNING ${key}`, now - RETENTION_MS).toArray();
      more ||= removed.length === 1000;
    }
    return more;
  }
}
