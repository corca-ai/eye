import type { HourlyGoalQuery } from '../analytics/hourly-goals.js';
import type { SummaryConfig, SummaryQuery, SummaryReport, SummaryStatus } from '../analytics/summaries.js';
import type { RuntimeEnv as Env } from './environment.generated.js';
import { invariant } from '../core/errors.js';
import { id, timestamp } from '../core/validation.js';
import type { GoalStatus } from '../core/types.js';
import { StoredObject } from './base.js';
import { IncrementalLearning } from './incremental.js';
import { ExperimentState } from './experiment-state.js';
import type { CreateExperiment, ExperimentSettings, ArmStatus } from '../core/types.js';
import { POLICY_REEVALUATION_MS } from '../policy-timing.js';
import { sendExportBatches } from '../analytics/export.js';
import { RETENTION_MS, OBSERVATION_GRACE_MS } from '../core/validation.js';
import type { EyeEvent } from '../core/types.js';

/** 골의 등록·상태 정보. 시각은 Unix ms이며 달성 조건·value는 각 goal 사건에서 서비스가 제공한다. */
export interface GoalDefinition { goalId: string; status: GoalStatus; createdAt: number; changedAt: number; revision: number }
export class SiteControl extends StoredObject {
  private readonly learning: IncrementalLearning;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        goal_id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at INTEGER NOT NULL,
        changed_at INTEGER NOT NULL, revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goal_history (
        goal_id TEXT NOT NULL, revision INTEGER NOT NULL, effective_at INTEGER NOT NULL, status TEXT NOT NULL,
        PRIMARY KEY (goal_id, revision)
      );
      CREATE INDEX IF NOT EXISTS goal_history_time ON goal_history(goal_id, effective_at DESC, revision DESC);
      CREATE TABLE IF NOT EXISTS experiments (experiment_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    `);
    this.learning = this.atomic(() => new IncrementalLearning(this.sql));
    if (this.learning.migratedDeadlines) void this.ctx.blockConcurrencyWhile(() => this.scheduleLearning(Date.now()));
    ExperimentState.initialize(this.sql);
  }
  private state(experimentId: string): ExperimentState { return new ExperimentState(this.sql, this.kv, id(experimentId, 'experimentId')); }
  private checkSite(siteId: string): void {
    id(siteId, 'siteId'); const previous = this.kv.get<string>('siteId');
    invariant(previous === undefined || previous === siteId, 'invalid_input', 'Site does not match this object');
  }
  createExperiment(siteId: string, input: CreateExperiment) {
    this.checkSite(siteId); id(input.experimentId, 'experimentId');
    return this.atomic(() => {
      const result = this.state(input.experimentId).create(input);
      this.noteSettings(result.settings); this.kv.put('siteId', siteId);
      this.sql.exec('INSERT OR IGNORE INTO experiments VALUES (?,?)', input.experimentId, result.createdAt);
      return result;
    });
  }
  getExperiment(siteId: string, experimentId: string) { this.checkSite(siteId); return this.state(experimentId).getConfig(); }
  updateExperiment(siteId: string, experimentId: string, patch: Partial<ExperimentSettings>) {
    this.checkSite(siteId);
    return this.atomic(() => { const result = this.state(experimentId).updateSettings(patch); this.noteSettings(result.settings); return result; });
  }
  addExperimentArm(siteId: string, experimentId: string, armId: string) {
    this.checkSite(siteId); return this.atomic(() => this.state(experimentId).addArm(armId));
  }
  setExperimentArmStatus(siteId: string, experimentId: string, armId: string, status: ArmStatus) {
    this.checkSite(siteId); return this.atomic(() => this.state(experimentId).setArmStatus(armId, status));
  }
  setExperimentStatus(siteId: string, experimentId: string, status: ArmStatus) {
    this.checkSite(siteId); return this.atomic(() => this.state(experimentId).setStatus(status));
  }
  getExperimentPolicy(siteId: string, experimentId: string) {
    this.checkSite(siteId); return this.state(experimentId).getPolicy();
  }
  async publishedPolicy(siteId: string, experimentId: string, maxAgeMs = POLICY_REEVALUATION_MS) {
    this.checkSite(siteId);
    const state = this.state(experimentId), cached = state.cachedPolicy(maxAgeMs); if (cached) return cached;
    await this.wakeAt(Date.now() + 1000);
    const result = this.atomic(() => state.publish(siteId, maxAgeMs));
    await this.scheduleLearning(Date.now()); return result;
  }
  createGoal(goalId: string): GoalDefinition {
    id(goalId, 'goalId');
    const existing = this.getGoal(goalId);
    if (existing) {
      invariant(existing.status !== 'deleted', 'deleted', 'Deleted goal IDs cannot be reused');
      return existing;
    }
    const now = Date.now();
    this.atomic(() => {
      this.sql.exec('INSERT INTO goals VALUES (?, ?, ?, ?, ?)', goalId, 'active', now, now, 1);
      this.sql.exec('INSERT INTO goal_history VALUES (?, ?, ?, ?)', goalId, 1, now, 'active');
    });
    return { goalId, status: 'active', createdAt: now, changedAt: now, revision: 1 };
  }
  getGoal(goalId: string): GoalDefinition | null {
    id(goalId, 'goalId');
    return this.sql.exec<{ goalId: string; status: GoalStatus; createdAt: number; changedAt: number; revision: number }>(
      'SELECT goal_id AS goalId, status, created_at AS createdAt, changed_at AS changedAt, revision FROM goals WHERE goal_id = ?', goalId,
    ).toArray()[0] ?? null;
  }
  setGoalStatus(goalId: string, status: GoalStatus): GoalDefinition {
    invariant(status === 'active' || status === 'paused' || status === 'deleted', 'invalid_input', 'Invalid goal status');
    const current = this.getGoal(goalId);
    invariant(current, 'not_found', 'Goal does not exist');
    if (current.status === status) return current;
    invariant(current.status !== 'deleted', 'deleted', 'Deleted goals cannot be resumed');
    const next = { ...current, status, changedAt: Date.now(), revision: current.revision + 1 };
    this.atomic(() => {
      this.sql.exec('UPDATE goals SET status = ?, changed_at = ?, revision = ? WHERE goal_id = ?', status, next.changedAt, next.revision, goalId);
      this.sql.exec('INSERT INTO goal_history VALUES (?, ?, ?, ?)', goalId, next.revision, next.changedAt, status);
    });
    return next;
  }
  goalStatusAt(goalId: string, occurredAt: number): GoalStatus | null {
    id(goalId, 'goalId'); timestamp(occurredAt, 'occurredAt');
    return this.sql.exec<{ status: GoalStatus }>('SELECT status FROM goal_history WHERE goal_id = ? AND effective_at <= ? ORDER BY effective_at DESC, revision DESC LIMIT 1', goalId, occurredAt).toArray()[0]?.status ?? null;
  }
  listGoals(after = '', limit = 100): GoalDefinition[] {
    invariant(Number.isInteger(limit) && limit > 0 && limit <= 1000, 'invalid_input', 'limit must be 1..1000');
    return this.sql.exec<{ goalId: string; status: GoalStatus; createdAt: number; changedAt: number; revision: number }>(
      'SELECT goal_id AS goalId, status, created_at AS createdAt, changed_at AS changedAt, revision FROM goals WHERE goal_id > ? ORDER BY goal_id LIMIT ?', after, limit,
    ).toArray();
  }
  listExperiments(after = '', limit = 100): string[] {
    invariant(Number.isInteger(limit) && limit > 0 && limit <= 1000, 'invalid_input', 'limit must be 1..1000');
    return this.sql.exec<{ experiment_id: string }>('SELECT experiment_id FROM experiments WHERE experiment_id > ? ORDER BY experiment_id LIMIT ?', after, limit).toArray().map(r => r.experiment_id);
  }
  noteSettings(settings: import('../core/types.js').ExperimentSettings): void {
    const previous = this.kv.get<{ windowMs: number; graceMs: number; attributionMs: number }>('learningBounds');
    const next = { windowMs: Math.max(previous?.windowMs ?? 0, settings.observationWindowMs),
      graceMs: Math.max(previous?.graceMs ?? 0, OBSERVATION_GRACE_MS),
      attributionMs: Math.max(previous?.attributionMs ?? 0, settings.attributionWindowMs ?? 7 * 86_400_000) };
    invariant(next.windowMs + next.graceMs + next.attributionMs < RETENTION_MS - 3_600_000,
      'invalid_input', 'Site historical maximum observation + grace + attribution horizons must leave an hour inside 60-day raw retention');
    if (JSON.stringify(previous) !== JSON.stringify(next)) this.kv.put('learningBounds', next);
  }
  acceptedGoals(goals: readonly import('../core/types.js').GoalEvent[]): boolean[] {
    invariant(goals.length <= 100, 'invalid_input', 'Too many goals');
    return goals.map(g => this.goalStatusAt(g.goalId, g.occurredAt) === 'active');
  }
  async configureSummaries(siteId: string, input: SummaryConfig): Promise<SummaryStatus> {
    id(siteId, 'siteId');
    const previous = this.kv.get<string>('siteId');
    invariant(previous === undefined || previous === siteId, 'conflict', 'Summary site does not match this object');
    const result = this.atomic(() => {
      const status = this.learning.summaries.configure(input, Date.now());
      this.kv.put('siteId', siteId);
      return status;
    });
    await this.scheduleLearning(Date.now());
    return result;
  }
  summaryStatus(): SummaryStatus { return this.learning.summaries.status(Date.now()); }
  querySummary(input: SummaryQuery): SummaryReport { return this.learning.summaries.query(input, Date.now()); }
  hourlyGoalStatus() { return this.learning.hourlyGoals.status(Date.now()); }
  hourlyGoals(input: HourlyGoalQuery) { return this.learning.hourlyGoals.query(input, Date.now()); }
  /** Queue ingestion and reward updates commit together. Only this batch is sorted. */
  async consumeLearning(siteId: string, events: readonly EyeEvent[], receivedAt?: readonly number[]): Promise<boolean[]> {
    this.checkSite(siteId);
    invariant(events.length <= 100 && (receivedAt === undefined || receivedAt.length === events.length), 'invalid_input', 'Invalid learning batch');
    const now = Date.now();
    const previousSiteId = this.kv.get<string>('siteId');
    const accepted = this.atomic(() => {
      // This synchronous transaction observes one definition per goal. Older
      // events still use history; no cache survives an administrative change.
      const definitions = new Map<string, GoalDefinition | null>();
      const assignments = new Map<string, boolean>();
      const { accepted, diagnostics } = this.learning.accept(events, now,
        goal => {
          if (!definitions.has(goal.goalId)) definitions.set(goal.goalId, this.getGoal(goal.goalId));
          const current = definitions.get(goal.goalId)!;
          return current !== null && (goal.occurredAt >= current.changedAt ? current.status : this.goalStatusAt(goal.goalId, goal.occurredAt)) === 'active';
        }, receivedAt, event => {
          const a = event.assignment, key = JSON.stringify([a.experimentId, a.armId, a.generation]);
          let valid = assignments.get(key);
          if (valid === undefined) { valid = this.state(a.experimentId).knowsAssignment(a); assignments.set(key, valid); }
          return valid;
        });
      if (previousSiteId === undefined) this.kv.put('siteId', siteId);
      const rejectedExposures = events.filter((event, i) => event.kind === 'exposure' && !accepted[i]).length;
      if (rejectedExposures) console.warn(JSON.stringify({ component: 'eye', operation: 'learning_rejected_exposures', siteId, count: rejectedExposures, code: 'conflict' }));
      if (Object.values(diagnostics).some(value => value > 0))
        console.log(JSON.stringify({ component: 'eye', operation: 'learning_approximation', siteId, ...diagnostics }));
      return accepted;
    });
    await this.scheduleLearning(now);
    return accepted;
  }
  override async alarm(): Promise<void> {
    await this.retryAlarm(async () => {
      const siteId = this.kv.get<string>('siteId');
      if (!siteId) { await this.ctx.storage.deleteAlarm(); this.kv.delete('alarmAt'); return; }
      const now = Date.now();
      // Reclaim before closing so a full summary store needs only one expiry
      // page in this alarm; close contributes at most 500 new buckets.
      this.atomic(() => {
        this.learning.prune(now);
        this.learning.close(siteId, now, cohort => {
          for (const experimentId of new Set(cohort.arms.map(a => a.experimentId))) this.state(experimentId).applyMoments({ ...cohort,
            arms: cohort.arms.filter(a => a.experimentId === experimentId) });
        });
      });
      const pending = this.learning.outputs();
      const policies = this.sql.exec<{ id: number; data: string }>('SELECT * FROM local_policy_outbox ORDER BY id LIMIT 100').toArray();
      const rows = pending.flatMap(item => item.output.records.map(record => ({ record })));
      rows.push(...policies.flatMap(item => (JSON.parse(item.data) as import('../analytics/records.js').AnalyticsRecord[]).map(record => ({ record }))));
      await sendExportBatches(rows, batch => this.env.ANALYTICS.send(batch));
      this.atomic(() => { this.learning.acknowledge(pending.map(item => item.id));
        for (const row of policies) this.sql.exec('DELETE FROM local_policy_outbox WHERE id=?', row.id); });
      await this.scheduleLearning(Date.now(), true);
    });
  }
  private async scheduleLearning(now: number, replace = false): Promise<void> {
    const at = this.sql.exec('SELECT id FROM local_policy_outbox LIMIT 1').toArray().length ? now + 1000 : this.learning.nextWake(now, replace);
    if (at === null) { await this.ctx.storage.deleteAlarm(); this.kv.delete('alarmAt'); return; }
    if (!replace) { await this.wakeAt(at); return; }
    const pending = this.ctx.storage.setAlarm(at);
    this.kv.put('alarmAt', at);
    await pending;
  }
}
