import type { RuntimeEnv as Env } from './environment.generated.js';
import { invariant } from '../core/errors.js';
import { id, timestamp } from '../core/validation.js';
import type { GoalStatus } from '../core/types.js';
import { compareIdentifiers } from '../core/attribution.js';
import { StoredObject } from './base.js';
import { LearningSource, COHORT_INTERVAL_MS, COHORT_PAGE_SIZE, type LearningPage } from './learning.js';
import { exportRecords, exportBatches } from '../analytics/export.js';
import { experimentKey, RETENTION_MS } from '../core/validation.js';
import { AnalyticsCapacityError, type AnalyticsEnv } from '../analytics/query.js';

export interface GoalDefinition { goalId: string; status: GoalStatus; createdAt: number; changedAt: number; revision: number }
export class SiteControl extends StoredObject {
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
  async registerExperiment(experimentId: string, siteId: string, settings: import('../core/types.js').ExperimentSettings): Promise<void> {
    id(experimentId, 'experimentId'); id(siteId, 'siteId');
    this.noteSettings(settings);
    await this.wakeAt(Date.now() + COHORT_INTERVAL_MS);
    this.kv.put('siteId', siteId);
    if (this.kv.get('learningFrom') === undefined) this.kv.put('learningFrom', Math.floor(Date.now() / COHORT_INTERVAL_MS) * COHORT_INTERVAL_MS);
    this.sql.exec('INSERT OR IGNORE INTO experiments VALUES (?, ?)', experimentId, Date.now());
  }
  listExperiments(after = '', limit = 100): string[] {
    invariant(Number.isInteger(limit) && limit > 0 && limit <= 1000, 'invalid_input', 'limit must be 1..1000');
    return this.sql.exec<{ experiment_id: string }>('SELECT experiment_id FROM experiments WHERE experiment_id > ? ORDER BY experiment_id LIMIT ?', after, limit).toArray().map(r => r.experiment_id);
  }
  noteSettings(settings: import('../core/types.js').ExperimentSettings): void {
    const previous = this.kv.get<{ windowMs: number; graceMs: number; attributionMs: number }>('learningBounds');
    const next = { windowMs: Math.max(previous?.windowMs ?? 0, settings.observationWindowMs),
      graceMs: Math.max(previous?.graceMs ?? 0, settings.allowedLatenessMs),
      attributionMs: Math.max(previous?.attributionMs ?? 0, settings.attributionWindowMs ?? 7 * 86_400_000) };
    invariant(next.windowMs + next.graceMs + next.attributionMs < RETENTION_MS - COHORT_INTERVAL_MS,
      'invalid_input', 'Site historical maximum observation + grace + attribution horizons must leave an hour inside 60-day raw retention');
    if (JSON.stringify(previous) !== JSON.stringify(next)) this.kv.put('learningBounds', next);
  }
  acceptedGoals(goals: readonly import('../core/types.js').GoalEvent[]): boolean[] {
    invariant(goals.length <= 100, 'invalid_input', 'Too many goals');
    return goals.map(g => this.goalStatusAt(g.goalId, g.occurredAt) === 'active');
  }
  /** One bounded page per alarm. Frozen R2 result precedes statistics/export/cursor,
   * so retries reuse the same result even if more raw events become queryable.
   */
  override async alarm(): Promise<void> { await this.retryAlarm(() => this.learnPage()); }
  private async learnPage(): Promise<void> {
    const siteId = this.kv.get<string>('siteId');
    if (!siteId) { await this.ctx.storage.deleteAlarm(); this.kv.delete('alarmAt'); return; }
    const now = Date.now();
    let from = this.kv.get<number>('learningFrom') ?? Math.floor(now / COHORT_INTERVAL_MS) * COHORT_INTERVAL_MS;
    if (from < now - RETENTION_MS + COHORT_INTERVAL_MS) {
      // Retention-exceeded outage: report skipped history instead of looping forever.
      console.warn(JSON.stringify({ component: 'eye', operation: 'learning_retention_gap', siteId, from }));
      from = Math.ceil((now - RETENTION_MS + COHORT_INTERVAL_MS) / COHORT_INTERVAL_MS) * COHORT_INTERVAL_MS;
      this.kv.put('learningFrom', from); this.kv.delete('learningAfter');
    }
    const until = from + COHORT_INTERVAL_MS;
    if (until > now) { await this.scheduleLearning(until); return; }
    const after = this.kv.get<string>('learningAfter') ?? '';
    const logicalId = JSON.stringify([siteId, from, until, after]);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(logicalId));
    const objectKey = `eye/cohorts/${[...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')}.json`;
    const existing = await this.env.COHORTS.get(objectKey);
    let page: LearningPage;
    if (existing) { invariant(existing.size <= 16 * 1024 * 1024, 'unavailable', 'Oversized frozen cohort'); page = await existing.json<LearningPage>(); }
    else {
      const limit = this.kv.get<number>('learningLimit') ?? COHORT_PAGE_SIZE;
      try {
        page = await new LearningSource(this.env as Env & AnalyticsEnv, siteId, this.kv.get('learningBounds')).page(from, until, after, limit);
        if (new TextEncoder().encode(JSON.stringify(page)).length > 16 * 1024 * 1024) throw new AnalyticsCapacityError('Oversized cohort result');
      }
      catch (error) {
        if (error instanceof AnalyticsCapacityError && limit > 1) this.kv.put('learningLimit', Math.max(1, Math.floor(limit / 2)));
        throw error;
      }
      const json = JSON.stringify(page);
      const written = await this.env.COHORTS.put(objectKey, json, { onlyIf: { etagDoesNotMatch: '*' } });
      if (!written) {
        const winner = await this.env.COHORTS.get(objectKey);
        invariant(winner && winner.size <= 16 * 1024 * 1024, 'unavailable', 'Missing frozen cohort');
        page = await winner.json<LearningPage>();
      }
    }
    invariant(page.cohort.cohortId === logicalId && page.cohort.asOf === until
      && (page.next === null || compareIdentifiers(page.next, after) > 0), 'conflict', 'Frozen cohort scope mismatch');
    for (const experimentId of new Set(page.cohort.arms.map(a => a.experimentId))) {
      await this.env.EXPERIMENTS.getByName(experimentKey(siteId, experimentId)).applyCohort({ ...page.cohort,
        arms: page.cohort.arms.filter(a => a.experimentId === experimentId) });
    }
    for (const batch of exportBatches(page.records.map(record => ({ record })))) await this.env.ANALYTICS.send(exportRecords(batch));
    this.atomic(() => {
      if (page.next === null) { this.kv.put('learningFrom', until); this.kv.delete('learningAfter'); this.kv.delete('learningLimit'); }
      else this.kv.put('learningAfter', page.next);
    });
    // Result deletion is safe only after advancing the durable cursor. A crash
    // before deletion can leave an orphan; bucket lifecycle may remove old results.
    await this.env.COHORTS.delete(objectKey);
    await this.scheduleLearning(page.next !== null || until + COHORT_INTERVAL_MS <= now ? now + 1000 : until + COHORT_INTERVAL_MS);
  }
  /** Replace the retry safety alarm after a successful page; otherwise wakeAt's
   * earliest-wins rule would keep an idle site waking every minute. */
  private async scheduleLearning(at: number): Promise<void> {
    const pending = this.ctx.storage.setAlarm(at);
    this.kv.put('alarmAt', at);
    await pending;
  }
}
