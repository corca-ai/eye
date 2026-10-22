import type { RuntimeEnv as Env } from './environment.generated.js';
import { invariant } from '../core/errors.js';
import { id, timestamp } from '../core/validation.js';
import type { GoalStatus } from '../core/types.js';
import { StoredObject } from './base.js';

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
  registerExperiment(experimentId: string): void {
    id(experimentId, 'experimentId');
    this.sql.exec('INSERT OR IGNORE INTO experiments VALUES (?, ?)', experimentId, Date.now());
  }
  listExperiments(after = '', limit = 100): string[] {
    invariant(Number.isInteger(limit) && limit > 0 && limit <= 1000, 'invalid_input', 'limit must be 1..1000');
    return this.sql.exec<{ experiment_id: string }>('SELECT experiment_id FROM experiments WHERE experiment_id > ? ORDER BY experiment_id LIMIT ?', after, limit).toArray().map(r => r.experiment_id);
  }
}
