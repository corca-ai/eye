import { POLICY_REEVALUATION_MS } from '../policy-timing.js';
import { analyticsRecord } from '../analytics/records.js';
import { invariant } from '../core/errors.js';
import { parseCreateExperiment } from '../core/events.js';
import { ageMoments, emptyMoments, mergeMoments } from '../core/moments.js';
import type { Moments } from '../core/moments.js';
import { evaluateUnreservedPolicy } from '../core/policy.js';
import type { ClosedCohort } from '../core/closed-cohort.js';
import { id, RETENTION_MS, settings, timestamp } from '../core/validation.js';
import type { ArmStatus, CreateExperiment, Experiment, ExperimentSettings } from '../core/types.js';
import type { LearningSQL } from './incremental.js';
const storedJson = <T>(text: string): T => JSON.parse(text) as T;

/** Synchronous experiment state owned by SiteControl's transaction. No RPC or independent alarm. */
export class ExperimentState {
  private readonly kv: Pick<SyncKvStorage, 'get' | 'put' | 'delete'>;
  constructor(private readonly sql: LearningSQL, storage: SyncKvStorage, private readonly experimentId: string) {
    const key = (suffix: string) => JSON.stringify(['experiment', experimentId, suffix]);
    this.kv = { get: <T>(suffix: string) => storage.get<T>(key(suffix)),
      put: <T>(suffix: string, value: T) => storage.put(key(suffix), value), delete: suffix => storage.delete(key(suffix)) };
  }
  static initialize(sql: LearningSQL): void {
    sql.exec(`CREATE TABLE IF NOT EXISTS local_arm_moments (
      experiment_id TEXT NOT NULL, generation INTEGER NOT NULL, arm_id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(experiment_id,generation,arm_id));
      CREATE TABLE IF NOT EXISTS local_policy_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);`);
  }
  create(input: CreateExperiment): Experiment {
    const current = this.kv.get<Experiment>('config');
    const original = this.kv.get<CreateExperiment>('definition');
    const parsed = parseCreateExperiment(input);
    invariant(parsed.experimentId === this.experimentId, 'invalid_input', 'Experiment state mismatch');
    if (current) {
      invariant(current.status !== 'deleted', 'conflict', 'Deleted experiment IDs cannot be reused');
      invariant(JSON.stringify(original) === JSON.stringify(parsed), 'conflict', 'Experiment already exists with a different initial definition');
      return current;
    }
    const config: Experiment = {
      experimentId: parsed.experimentId, status: 'active', generation: 1, revision: 1, createdAt: Date.now(),
      settings: parsed.settings, arms: parsed.arms.map(armId => ({ armId, status: 'active' })),
    };
    this.kv.put('definition', parsed); this.kv.put('config', config); this.kv.put('generation:1', config.settings);
    return config;
  }
  getConfig(): Experiment {
    const config = this.kv.get<Experiment>('config');
    invariant(config, 'not_found', 'Experiment does not exist');
    return config;
  }
  getGeneration(generation: number): ExperimentSettings {
    const result = this.kv.get<ExperimentSettings>(`generation:${generation}`);
    invariant(result, 'not_found', 'Experiment generation does not exist');
    return result;
  }
  addArm(armId: string): Experiment {
    id(armId, 'armId');
    const config = this.getConfig();
    invariant(config.status !== 'deleted', 'conflict', 'Experiment is deleted');
    const existing = config.arms.find(a => a.armId === armId);
    invariant(existing?.status !== 'deleted', 'conflict', 'Deleted arm IDs cannot be reused');
    if (existing) return config;
    const next = { ...config, revision: config.revision + 1, arms: [...config.arms, { armId, status: 'active' as const }] };
    this.kv.put('config', next);
    return next;
  }
  setArmStatus(armId: string, status: ArmStatus): Experiment {
    invariant(status === 'active' || status === 'paused' || status === 'deleted', 'invalid_input', 'Invalid arm status');
    const config = this.getConfig();
    const arm = config.arms.find(a => a.armId === armId);
    invariant(arm, 'not_found', 'Arm does not exist');
    invariant(config.status !== 'deleted', 'conflict', 'Experiment is deleted');
    if (arm.status === status) return config;
    invariant(arm.status !== 'deleted', 'conflict', 'Deleted arm cannot be resumed');
    const next = { ...config, revision: config.revision + 1, arms: config.arms.map(a => a.armId === armId ? { ...a, status } : a) };
    this.kv.put('config', next);
    return next;
  }
  setStatus(status: ArmStatus): Experiment {
    invariant(status === 'active' || status === 'paused' || status === 'deleted', 'invalid_input', 'Invalid experiment status');
    const config = this.getConfig();
    if ((config.status ?? 'active') === status) return config;
    invariant(config.status !== 'deleted', 'conflict', 'Deleted experiment cannot be resumed');
    const next = { ...config, status, revision: config.revision + 1 };
    this.kv.put('config', next);
    return next;
  }
  updateSettings(input: Partial<ExperimentSettings>): Experiment {
    const config = this.getConfig();
    invariant(config.status !== 'deleted', 'conflict', 'Experiment is deleted');
    const nextSettings = settings({ ...config.settings, ...input });
    if (JSON.stringify(config.settings) === JSON.stringify(nextSettings)) return config;
    // Any policy-setting change starts a generation: no old half-life is reinterpreted.
    const next = { ...config, settings: nextSettings, generation: config.generation + 1, revision: config.revision + 1 };
    this.kv.put('config', next); this.kv.put(`generation:${next.generation}`, nextSettings);
    return next;
  }
  getPolicy() {
    const config = this.getConfig();
    const rows = this.sql.exec<{ arm_id: string; data: string }>('SELECT arm_id, data FROM local_arm_moments WHERE experiment_id = ? AND generation = ?', this.experimentId, config.generation).toArray();
    const moments = new Map(rows.map(r => [r.arm_id, storedJson<Moments>(r.data)]));
    const now = Math.max(Date.now(), ...[...moments.values()].map(m => m.asOf));
    const policy = evaluateUnreservedPolicy(config.arms.filter(a => (config.status ?? 'active') === 'active' && a.status === 'active').map(a => ({
      armId: a.armId, moments: moments.get(a.armId) ?? emptyMoments(now),
    })), { ...config.settings, bootstrapShare: config.settings.bootstrapShare ?? 0.2 }, now);
    return { ...policy, experimentId: config.experimentId, generation: config.generation, revision: config.revision,
      statsAsOf: this.kv.get<number>('statsAsOf') ?? null };
  }
  /** Caller atomically closes samples, applies their moments and records export. */
  applyMoments(cohort: Pick<ClosedCohort, 'asOf' | 'arms'>): void {
    timestamp(cohort.asOf, 'cohort.asOf');
    invariant(cohort.asOf >= Date.now() - RETENTION_MS && cohort.asOf <= Date.now() + 60_000, 'outside_retention', 'Cohort outside learning retention');
    const config = this.getConfig();
    for (const arm of cohort.arms) {
      invariant(arm.experimentId === config.experimentId && config.arms.some(a => a.armId === arm.armId), 'invalid_input', 'Unknown cohort arm');
      const settings = this.getGeneration(arm.generation), m = arm.moments;
      invariant(m.asOf === cohort.asOf && [m.weight, m.scale, m.mean, m.m2].every(Number.isFinite)
        && m.weight >= 0 && m.scale > 0 && m.m2 >= 0, 'invalid_input', 'Invalid cohort moments');
      const row = this.sql.exec<{ data: string }>('SELECT data FROM local_arm_moments WHERE experiment_id=? AND generation=? AND arm_id=?',
        this.experimentId, arm.generation, arm.armId).toArray()[0];
      const old = row ? storedJson<Moments>(row.data) : emptyMoments(m.asOf), now = Math.max(old.asOf, m.asOf);
      const next = mergeMoments(ageMoments(old, now, settings.learningHalfLifeMs), ageMoments(m, now, settings.learningHalfLifeMs));
      this.importMoment({ generation: arm.generation, arm_id: arm.armId, data: JSON.stringify(next) });
    }
    if (!this.kv.get('policyDirty')) this.kv.put('policyDirty', true);
    this.kv.put('statsAsOf', Math.max(this.kv.get<number>('statsAsOf') ?? 0, cohort.asOf));
  }
  cachedPolicy(maxAgeMs: number): import('../transport.js').PublishedPolicy | undefined {
    invariant(Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0, 'invalid_input', 'Invalid policy maximum age');
    const config = this.getConfig(), previous = this.kv.get<import('../transport.js').PublishedPolicy>('publishedPolicy');
    return previous && Date.now() - previous.publishedAt < Math.min(POLICY_REEVALUATION_MS, maxAgeMs, Math.max(1, Math.floor(config.settings.learningHalfLifeMs / 8)))
      && previous.revision === config.revision && !this.kv.get('policyDirty') ? previous : undefined;
  }
  publish(siteId: string, maxAgeMs: number): import('../transport.js').PublishedPolicy {
    const cached = this.cachedPolicy(maxAgeMs); if (cached) return cached;
    const config = this.getConfig(), previous = this.kv.get<import('../transport.js').PublishedPolicy>('publishedPolicy');
    const policy = this.getPolicy();
    const result = { ...policy, settings: config.settings, publishedAt: Date.now(), sequence: (previous?.sequence ?? 0) + 1,
      status: config.status ?? 'active' as const, activeArms: config.arms.filter(a => a.status === 'active').map(a => a.armId) };
    this.kv.put('publishedPolicy', result); if (this.kv.get('policyDirty')) this.kv.delete('policyDirty');
    const history = config.arms.map(configured => result.arms.find(a => a.armId === configured.armId) ?? { armId: configured.armId, probability: 0, meanReward: null, score: null });
    const records = history.map(arm => analyticsRecord({ siteId, subjectKey: '' }, 'policies',
      JSON.stringify([config.experimentId, result.sequence, arm.armId]), 1, result.publishedAt, result.publishedAt,
      { ...arm, reason: 'published', status: result.status === 'active' ? config.arms.find(a => a.armId === arm.armId)!.status : result.status,
        generation: result.generation, sequence: result.sequence, revision: result.revision, asOf: result.asOf, scoreScale: result.scoreScale },
      { experiment_id: config.experimentId, arm_id: arm.armId, status: 'published', value: arm.probability }));
    this.sql.exec('INSERT INTO local_policy_outbox(data) VALUES (?)', JSON.stringify(records));
    return result;
  }
  // TEMP-CODE(issue: #13, remove-when: pre-atomic upgrades unsupported, check: each-release): import frozen legacy state.
  importValue(suffix: string, value: unknown): void { this.kv.put(suffix, value); }
  importMoment(row: { generation: number; arm_id: string; data: string }): void {
    this.sql.exec(`INSERT INTO local_arm_moments VALUES (?,?,?,?) ON CONFLICT(experiment_id,generation,arm_id) DO UPDATE SET data=excluded.data`,
      this.experimentId, row.generation, row.arm_id, row.data);
  }
}
