import { IncrementalSummaries } from './summaries.js';
import { compareEvents } from '../core/attribution.js';
import { closedSampleMoments, type ClosedSample, type ClosedCohort } from '../core/closed-cohort.js';
import { finite, invariant } from '../core/errors.js';
import { decayFactor } from '../core/moments.js';
import { addReward, type RewardSum } from '../core/reward-sum.js';
import type { ExposureEvent, EyeEvent, GoalEvent, IdentityEvent } from '../core/types.js';
import { RETENTION_MS, subjectKey } from '../core/validation.js';
import { analyticsRecord, type AnalyticsRecord } from '../analytics/records.js';

type SampleEvent = ExposureEvent & { sample: NonNullable<ExposureEvent['sample']>; attributionWindowMs: number };
type IdentityRow = { uid: string | null; occurred_at: number; event_id: string };
type Last = { occurredAt: number; eventId: string; sampleId: string; attributionWindowMs: number };
type SampleState = { row: SampleRow; event: SampleEvent; inserted: boolean; dataChanged: boolean; rewardChanged: boolean };
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

/** Compact references remain after sample closure: they still participate in the denominator. */
function lastReference(event: SampleEvent): Last {
  return { occurredAt: event.occurredAt, eventId: event.eventId,
    sampleId: event.sample.sampleId, attributionWindowMs: event.attributionWindowMs };
}
function readLast(data: string): Last {
  const value = decode<Last | SampleEvent>(data);
  // Old full-event rows are rewritten only when the reference changes.
  return 'assignment' in value ? lastReference(value) : value;
}

/** One accept call, discarded even when the surrounding transaction rolls back. */
class LearningBatch {
  private readonly identities = new Map<string, IdentityRow | null>();
  private readonly dirtyIdentities = new Set<string>();
  private readonly owners = new Map<string, { values: Map<string, Last>; dirty: Set<string> }>();
  private readonly samples = new Map<string, SampleState | null>();
  constructor(private readonly sql: LearningSQL) {}
  identity(cid: string): IdentityRow | null {
    if (!this.identities.has(cid)) this.identities.set(cid, this.sql.exec<IdentityRow>(
      'SELECT uid, occurred_at, event_id FROM learning_identity WHERE cid = ?', cid).toArray()[0] ?? null);
    return this.identities.get(cid)!;
  }
  setIdentity(cid: string, value: IdentityRow): void { this.identities.set(cid, value); this.dirtyIdentities.add(cid); }
  last(owner: string): Map<string, Last> {
    let state = this.owners.get(owner);
    if (!state) {
      state = { values: new Map(this.sql.exec<{ experiment_id: string; data: string }>(
        'SELECT experiment_id, data FROM learning_last WHERE owner = ?', owner).toArray()
        .map(row => [row.experiment_id, readLast(row.data)])), dirty: new Set() };
      this.owners.set(owner, state);
    }
    return state.values;
  }
  setLast(owner: string, experimentId: string, value: Last): void {
    this.last(owner).set(experimentId, value); this.owners.get(owner)!.dirty.add(experimentId);
  }
  clearLast(owner: string): void {
    const values = this.last(owner), dirty = this.owners.get(owner)!.dirty;
    for (const key of values.keys()) dirty.add(key);
    values.clear();
  }
  sample(id: string): SampleState | null {
    if (!this.samples.has(id)) {
      const row = this.sql.exec<SampleRow>('SELECT * FROM learning_samples WHERE sample_id = ?', id).toArray()[0];
      this.samples.set(id, row ? { row, event: decode<SampleEvent>(row.data), inserted: false, dataChanged: false, rewardChanged: false } : null);
    }
    return this.samples.get(id)!;
  }
  createSample(row: SampleRow, event: SampleEvent): void {
    this.samples.set(row.sample_id, { row, event, inserted: true, dataChanged: false, rewardChanged: false });
  }
  flush(): void {
    for (const cid of this.dirtyIdentities) {
      const value = this.identities.get(cid)!;
      this.sql.exec(`INSERT INTO learning_identity VALUES (?, ?, ?, ?) ON CONFLICT(cid) DO UPDATE SET
        uid = excluded.uid, occurred_at = excluded.occurred_at, event_id = excluded.event_id`, cid, value.uid, value.occurred_at, value.event_id);
    }
    for (const [owner, { values, dirty }] of this.owners) for (const experimentId of dirty) {
      const value = values.get(experimentId);
      if (value) this.sql.exec(`INSERT INTO learning_last VALUES (?, ?, ?, ?) ON CONFLICT(owner, experiment_id) DO UPDATE SET
        occurred_at = excluded.occurred_at, data = excluded.data`, owner, experimentId, value.occurredAt, JSON.stringify(value));
      else this.sql.exec('DELETE FROM learning_last WHERE owner = ? AND experiment_id = ?', owner, experimentId);
    }
    for (const state of this.samples.values()) {
      if (!state) continue;
      const r = state.row;
      if (state.inserted) this.sql.exec('INSERT INTO learning_samples VALUES (?, ?, ?, ?, ?, ?, ?)',
        r.sample_id, r.close_at, r.data, r.definition, r.scale, r.sum, r.correction);
      else if (state.dataChanged) this.sql.exec('UPDATE learning_samples SET data = ?, scale = ?, sum = ?, correction = ? WHERE sample_id = ?',
        r.data, r.scale, r.sum, r.correction, r.sample_id);
      else if (state.rewardChanged) this.sql.exec('UPDATE learning_samples SET scale = ?, sum = ?, correction = ? WHERE sample_id = ?',
        r.scale, r.sum, r.correction, r.sample_id);
    }
  }
}

/** Synchronous durable state. The caller wraps accept/close in transactionSync.
 * Only the received batch is sorted; there is no global reorder buffer or replay.
 */
export class IncrementalLearning {
  readonly summaries: IncrementalSummaries;
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
    this.summaries = new IncrementalSummaries(sql);
  }
  accept(events: readonly EyeEvent[], now: number, goalActive: (goal: GoalEvent) => boolean = () => true): LearningReceipt {
    const diagnostics: LearningDiagnostics = { staleExposures: 0, staleIdentities: 0, futureExposures: 0, closedGoals: 0 };
    const accepted = events.map(() => true);
    const batch = new LearningBatch(this.sql), summaries = this.summaries.batch(now);
    for (const { event, index } of events.map((event, index) => ({ event, index })).sort((a, b) => compareEvents(a.event, b.event))) {
      if (event.kind === 'track') continue;
      if (event.kind === 'goal') {
        const status = goalActive(event);
        const inserted = this.sql.exec<{ accepted: number }>('INSERT OR IGNORE INTO learning_seen VALUES (?, ?, ?) RETURNING accepted',
          event.eventId, event.occurredAt, Number(status)).toArray();
        if (inserted.length === 0) {
          accepted[index] = this.sql.exec<{ accepted: number }>('SELECT accepted FROM learning_seen WHERE event_id = ?', event.eventId).toArray()[0]!.accepted === 1;
          continue;
        }
        accepted[index] = status;
        if (status) { this.goal(batch, event, now, diagnostics); summaries.goal(event); }
      } else if (event.kind === 'identify' || event.kind === 'logout') this.identity(batch, event, diagnostics);
      else if (event.kind === 'exposure') this.exposure(batch, event, now, diagnostics);
    }
    batch.flush(); summaries.flush();
    return { accepted, diagnostics };
  }
  private identity(batch: LearningBatch, event: IdentityEvent, diagnostics: LearningDiagnostics): void {
    const { cid } = event.subject, current = batch.identity(cid);
    if (current && compareEvents({ occurredAt: current.occurred_at, eventId: current.event_id }, event) >= 0) {
      diagnostics.staleIdentities++; return;
    }
    const anonymous = ownerKey('cid', cid);
    if (event.kind === 'identify') {
      const uid = event.subject.uid!;
      if (current?.uid !== uid) {
        if (current?.uid == null) for (const [experimentId, reference] of batch.last(anonymous))
          this.putLast(batch, ownerKey('uid', uid), experimentId, reference, diagnostics);
        batch.clearLast(anonymous);
      }
    } else batch.clearLast(anonymous);
    batch.setIdentity(cid, { uid: event.kind === 'identify' ? event.subject.uid! : null, occurred_at: event.occurredAt, event_id: event.eventId });
  }
  private exposure(batch: LearningBatch, event: ExposureEvent, now: number, diagnostics: LearningDiagnostics): void {
    invariant(event.sample && event.attributionWindowMs, 'invalid_input', 'Exposure needs local sample context');
    const exposure = event as SampleEvent;
    const sampleId = exposure.sample.sampleId;
    const closeAt = exposure.sample.startAt + exposure.assignment.settings.observationWindowMs + exposure.assignment.settings.allowedLatenessMs;
    const definition = JSON.stringify([exposure.assignment, exposure.sample.startAt, exposure.attributionWindowMs]);
    if (closeAt > now) {
      const old = batch.sample(sampleId);
      if (!old) batch.createSample({ sample_id: sampleId, close_at: closeAt, data: JSON.stringify(exposure), definition, scale: 0, sum: 0, correction: 0 }, exposure);
      else {
        invariant(old.row.definition === definition, 'conflict', 'Conflicting sample context');
        if (compareEvents(exposure, old.event) < 0) {
          old.event = exposure; old.row.data = JSON.stringify(exposure); old.dataChanged = true;
        }
      }
    }
    const reference = lastReference(exposure), experimentId = exposure.assignment.experimentId;
    if (exposure.subject.uid !== undefined) this.putLast(batch, ownerKey('uid', exposure.subject.uid), experimentId, reference, diagnostics);
    else {
      const identity = batch.identity(exposure.subject.cid);
      // A duplicate/late exposure from before logout cannot restore the old segment.
      // Sample creation above is independent: zero-reward observations still count.
      if (identity?.uid == null && (!identity || compareEvents(exposure, { occurredAt: identity.occurred_at, eventId: identity.event_id }) > 0))
        this.putLast(batch, ownerKey('cid', exposure.subject.cid), experimentId, reference, diagnostics);
    }
  }
  private putLast(batch: LearningBatch, owner: string, experimentId: string, event: Last, diagnostics: LearningDiagnostics): void {
    const previous = batch.last(owner).get(experimentId);
    if (previous && compareEvents(previous, event) >= 0) { diagnostics.staleExposures++; return; }
    batch.setLast(owner, experimentId, event);
  }
  private goal(batch: LearningBatch, goal: GoalEvent, now: number, diagnostics: LearningDiagnostics): void {
    const owner = goal.subject.uid === undefined ? ownerKey('cid', goal.subject.cid) : ownerKey('uid', goal.subject.uid);
    const eligible: Last[] = [];
    for (const event of batch.last(owner).values()) {
      if (compareEvents(event, goal) > 0) { diagnostics.futureExposures++; continue; }
      if (goal.occurredAt - event.occurredAt <= event.attributionWindowMs) eligible.push(event);
    }
    for (const event of eligible) {
      const sample = batch.sample(event.sampleId);
      if (!sample || sample.row.close_at <= now) { diagnostics.closedGoals++; continue; }
      const exposure = sample.event, endAt = exposure.sample.startAt + exposure.assignment.settings.observationWindowMs;
      if (goal.occurredAt < exposure.sample.startAt || goal.occurredAt >= endAt) continue;
      const baseValue = goal.value / eligible.length;
      const factor = decayFactor(goal.occurredAt - event.occurredAt, exposure.assignment.settings.attributionHalfLifeMs);
      addReward(sample.row, baseValue * factor);
      sample.rewardChanged = true;
    }
  }
  /** Freeze a bounded set of zero/nonzero completed samples and remove them in the same transaction. */
  close(siteId: string, now: number): number {
    const rows = this.sql.exec<SampleRow>('SELECT * FROM learning_samples WHERE close_at <= ? ORDER BY close_at, sample_id LIMIT ?', now, CLOSE_LIMIT);
    const records: AnalyticsRecord[] = [], samples: ClosedSample[] = [];
    const summaries = this.summaries.batch(now);
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
      summaries.observation(a, event.sample.startAt, reward);
      samples.push({ sampleId: row.sample_id, assignment: a, startAt: event.sample.startAt, endAt, reward });
    }
    for (let offset = 0; offset < samples.length; offset += 100) {
      const ids = samples.slice(offset, offset + 100).map(sample => sample.sampleId);
      this.sql.exec(`DELETE FROM learning_samples WHERE sample_id IN (${ids.map(() => '?').join(',')})`, ...ids);
    }
    summaries.flush();
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
      SELECT MIN(occurred_at) AS at FROM learning_last UNION ALL
      SELECT MIN(bucket) AS at FROM summary_buckets)`).toArray()[0]!.at;
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
    return this.summaries.prune(now) || more;
  }
}
