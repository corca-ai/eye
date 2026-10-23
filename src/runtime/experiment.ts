import { analyticsRecord } from '../analytics/records.js';
import { exportRecords, exportBatches } from '../analytics/export.js';
import type { AnalyticsRecord } from '../analytics/records.js';
import type { RuntimeEnv as Env } from './environment.generated.js';
import { invariant } from '../core/errors.js';
import { parseCreateExperiment } from '../core/events.js';
import { ageMoments, emptyMoments, mergeMoments } from '../core/moments.js';
import type { Moments } from '../core/moments.js';
import { chooseArm, evaluatePolicy, randomUnit } from '../core/policy.js';
import { id, record, RETENTION_MS, settings, timestamp } from '../core/validation.js';
import type { ArmStatus, Assignment, CreateExperiment, Experiment, ExperimentSettings } from '../core/types.js';
import { StoredObject, storedJson } from './base.js';

export interface ShardSnapshot {
  generation: number; shard: number; sequence: number; asOf: number; moments: Record<string, Moments>; pending: Record<string, number>; releaseReservations: string[];
}
type ReservationRow = { id: string; arm_id: string; generation: number; state: string; expires_at: number; data: string }
export interface Reservation {
  assignment: Assignment;
  state: 'reserved' | 'observing' | 'released';
}

export class ExperimentObject extends StoredObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS policy_outbox (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY, arm_id TEXT NOT NULL, generation INTEGER NOT NULL,
        state TEXT NOT NULL, expires_at INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reservation_expiry ON reservations(state, expires_at);
      CREATE INDEX IF NOT EXISTS reservation_next_expiry ON reservations(expires_at);
      CREATE TABLE IF NOT EXISTS pending_counts (generation INTEGER NOT NULL, arm_id TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(generation, arm_id));
    `);
  }
  create(input: CreateExperiment): Experiment {
    const current = this.kv.get<Experiment>('config');
    const original = this.kv.get<CreateExperiment>('definition');
    const raw = record(input, 'experiment'), rawSettings = record(raw.settings, 'settings');
    const legacy = current !== undefined && original?.settings.correctionWindowMs === undefined && rawSettings.correctionWindowMs === undefined;
    const parsed = parseCreateExperiment(legacy ? { ...raw, settings: { ...rawSettings, correctionWindowMs: RETENTION_MS } } : input);
    if (current) {
      invariant(current.status !== 'deleted', 'conflict', 'Deleted experiment IDs cannot be reused');
      const { correctionWindowMs: _horizon, ...legacySettings } = parsed.settings;
      const comparable = legacy
        ? { ...parsed, settings: legacySettings } : parsed;
      invariant(JSON.stringify(original) === JSON.stringify(comparable), 'conflict', 'Experiment already exists with a different initial definition');
      return current;
    }
    const config: Experiment = {
      experimentId: parsed.experimentId, status: 'active', generation: 1, revision: 1, createdAt: Date.now(),
      settings: parsed.settings, arms: parsed.arms.map(armId => ({ armId, status: 'active' })),
    };
    this.atomic(() => { this.kv.put('definition', parsed); this.kv.put('config', config); this.kv.put('generation:1', config.settings); });
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
    this.atomic(() => { this.kv.put('config', next); this.kv.put(`generation:${next.generation}`, nextSettings); });
    return next;
  }
  getPolicy() {
    const config = this.getConfig(), now = Date.now();
    this.expire(now);
    let statsAsOf: number | null = null;
    const moments = new Map<string, Moments>();
    const pending = new Map(this.sql.exec<{ arm_id: string; count: number }>('SELECT arm_id, count FROM pending_counts WHERE generation = ?', config.generation).toArray().map(r => [r.arm_id, r.count]));
    for (let shard = 0; shard < 16; shard++) {
      const snapshot = this.kv.get<ShardSnapshot>(`snapshot:${config.generation}:${shard}`);
      if (!snapshot) continue;
      statsAsOf = statsAsOf === null ? snapshot.asOf : Math.min(statsAsOf, snapshot.asOf);
      for (const [armId, count] of Object.entries(snapshot.pending)) pending.set(armId, (pending.get(armId) ?? 0) + count);
      for (const [armId, m] of Object.entries(snapshot.moments)) {
        const aged = ageMoments(m, now, config.settings.learningHalfLifeMs);
        moments.set(armId, mergeMoments(moments.get(armId) ?? emptyMoments(now), aged));
      }
    }
    const policy = evaluatePolicy(config.arms.filter(a => (config.status ?? 'active') === 'active' && a.status === 'active').map(a => ({
      armId: a.armId, pending: pending.get(a.armId) ?? 0, moments: moments.get(a.armId) ?? emptyMoments(now),
    })), config.settings, now);
    return { ...policy, experimentId: config.experimentId, generation: config.generation, revision: config.revision, statsAsOf };
  }
  async publishedPolicy(siteId?: string): Promise<import('../transport.js').PublishedPolicy> {
    if (siteId !== undefined) id(siteId, 'siteId');
    let previous = this.kv.get<import('../transport.js').PublishedPolicy>('publishedPolicy');
    if (previous && Date.now() - previous.publishedAt < 60_000) return previous;
    if (siteId) await this.wakeAt(Date.now() + 1000);
    previous = this.kv.get<import('../transport.js').PublishedPolicy>('publishedPolicy');
    if (previous && Date.now() - previous.publishedAt < 60_000) return previous;
    const config = this.getConfig(), policy = this.getPolicy();
    const result = { ...policy, publishedAt: Date.now(), sequence: (previous?.sequence ?? 0) + 1,
      status: config.status ?? 'active' as const, activeArms: config.arms.filter(a => a.status === 'active').map(a => a.armId) };
    this.atomic(() => {
      this.kv.put('publishedPolicy', result);
      if (siteId) {
        const records = config.arms.map(configArm => {
          const arm = result.arms.find(a => a.armId === configArm.armId);
          return analyticsRecord({ siteId, subjectKey: '' }, 'policies',
          JSON.stringify([config.experimentId, result.sequence, configArm.armId]), 1, result.publishedAt, result.publishedAt,
          { probability: arm?.probability ?? 0, meanReward: arm?.meanReward ?? null, score: arm?.score ?? null,
            status: (config.status ?? 'active') === 'active' ? configArm.status : config.status,
            generation: config.generation, scoreScale: result.scoreScale, reason: 'published' }, { experiment_id: config.experimentId, arm_id: configArm.armId });
        });
        this.sql.exec('INSERT INTO policy_outbox VALUES (?, ?)', result.sequence, JSON.stringify(records));
      }
    });
    return result;
  }
  async reserve(requestId: string, requestedAt: number): Promise<Assignment | null> {
    id(requestId, 'requestId'); timestamp(requestedAt, 'requestedAt');
    // Persist an alarm before creating a reservation, including on eviction/retry paths.
    await this.wakeAt(Date.now() + 60_000);
    return this.atomic(() => {
      const config = this.getConfig(), now = Date.now();
      this.expire(now);
      invariant(requestedAt <= now, 'invalid_input', 'Reservation request is in the future');
      if ((config.status ?? 'active') !== 'active') return null;
      if (now >= requestedAt + config.settings.reservationTtlMs) return null;
      const old = this.reservation(requestId);
      if (old) {
        if (old.state !== 'reserved') return null;
        const assignment = storedJson<Assignment>(old.data);
        if (assignment.generation !== config.generation || !config.arms.some(a => a.armId === assignment.armId && a.status === 'active')) return null;
        return assignment;
      }
      const evaluation = this.getPolicy();
      const chosen = chooseArm(evaluation, randomUnit());
      if (!chosen) return null;
      const assignment: Assignment = {
        assignmentId: requestId, experimentId: config.experimentId, armId: chosen.armId,
        generation: config.generation, assignedAt: now, policyRevision: config.revision,
        probability: chosen.probability, settings: config.settings,
      };
      this.sql.exec('INSERT INTO reservations VALUES (?, ?, ?, ?, ?, ?)', requestId, chosen.armId, config.generation, 'reserved', requestedAt + config.settings.reservationTtlMs, JSON.stringify(assignment));
      this.changePending(config.generation, chosen.armId, 1);
      return assignment;
    });
  }
  release(reservationId: string): void { this.atomic(() => this.releaseLocal(reservationId, Date.now())); }
  acceptSnapshot(snapshot: ShardSnapshot): void {
    invariant(Number.isInteger(snapshot.shard) && snapshot.shard >= 0 && snapshot.shard < 16, 'invalid_input', 'Invalid statistics shard');
    invariant(snapshot.asOf <= Date.now(), 'invalid_input', 'Future statistics snapshot');
    this.getGeneration(snapshot.generation);
    const key = `snapshot:${snapshot.generation}:${snapshot.shard}`;
    const old = this.kv.get<ShardSnapshot>(key);
    this.atomic(() => {
      // Every retry can acknowledge short reservations, but stale snapshots never replace counts.
      for (const reservationId of snapshot.releaseReservations) this.releaseLocal(reservationId, Date.now());
      if (old && old.sequence >= snapshot.sequence) return;
      this.kv.put(key, { ...snapshot, releaseReservations: [] });
    });
  }
  private reservation(key: string): ReservationRow | undefined {
    return this.sql.exec<ReservationRow>('SELECT * FROM reservations WHERE id = ?', key).toArray()[0];
  }
  private changePending(generation: number, armId: string, delta: number): void {
    this.sql.exec('INSERT INTO pending_counts VALUES (?, ?, ?) ON CONFLICT(generation, arm_id) DO UPDATE SET count = count + excluded.count', generation, armId, delta);
    invariant(this.sql.exec<{ count: number }>('SELECT count FROM pending_counts WHERE generation = ? AND arm_id = ?', generation, armId).one().count >= 0, 'conflict', 'Negative pending count');
  }
  private releaseLocal(key: string, now: number): void {
    const old = this.reservation(key);
    if (!old) return;
    if (old.state === 'released') return;
    this.changePending(old.generation, old.arm_id, -1);
    this.sql.exec('UPDATE reservations SET state = ? WHERE id = ?', 'released', key);
  }
  private expire(now: number): void {
    // Bounded per request; remaining due rows are drained by alarms.
    const due = this.sql.exec<ReservationRow>("SELECT * FROM reservations WHERE state IN ('reserved', 'observing') AND expires_at <= ? LIMIT 1000", now).toArray();
    for (const r of due) this.releaseLocal(r.id, now);
    this.sql.exec("DELETE FROM reservations WHERE id IN (SELECT id FROM reservations WHERE state = 'released' AND expires_at <= ? LIMIT 1000)", now);
  }
  override async alarm(): Promise<void> {
    this.alarmStarted();
    this.atomic(() => this.expire(Date.now()));
    await this.wakeAt(Date.now() + 10_000);
    for (const row of this.sql.exec<{ id: number; data: string }>('SELECT * FROM policy_outbox ORDER BY id LIMIT 100').toArray()) {
      for (const batch of exportBatches(storedJson<AnalyticsRecord[]>(row.data).map(record => ({ record })))) await this.env.ANALYTICS.send(exportRecords(batch));
      this.sql.exec('DELETE FROM policy_outbox WHERE id = ?', row.id);
    }
    const due = this.sql.exec<{ next: number | null }>('SELECT MIN(expires_at) AS next FROM reservations').one().next;
    const more = this.sql.exec('SELECT id FROM policy_outbox LIMIT 1').toArray().length > 0;
    const at = more ? Date.now() + 1000 : due;
    if (at !== null) { await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, at)); this.kv.put('alarmAt', Math.max(Date.now() + 1000, at)); }
    else { await this.ctx.storage.deleteAlarm(); this.kv.delete('alarmAt'); }
  }
}
