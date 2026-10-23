import type { RuntimeEnv as Env } from './environment.generated.js';
import { invariant } from '../core/errors.js';
import { addSample, ageMoments, decayFactor, emptyMoments, removeSample } from '../core/moments.js';
import type { Moments } from '../core/moments.js';
import type { ExperimentSettings, Observation } from '../core/types.js';
import { experimentKey, id, RETENTION_MS } from '../core/validation.js';
import { StoredObject, storedJson } from './base.js';
import type { ShardSnapshot } from './experiment.js';

export function observationShard(subjectKey: string): number {
  let hash = 2166136261;
  for (let i = 0; i < subjectKey.length; i++) hash = Math.imul(hash ^ subjectKey.charCodeAt(i), 16777619);
  return (hash >>> 0) % 16;
}
export function shardKey(siteId: string, experimentId: string, shard: number): string {
  return JSON.stringify([siteId, experimentId, shard]);
}
interface ShardIdentity { siteId: string; experimentId: string; shard: number }
type ObservationRow = { revision: number; counted: number; data: string };

export class ObservationShard extends StoredObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        settle_at INTEGER NOT NULL, counted INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS observation_expiry ON observations(expires_at);
      CREATE INDEX IF NOT EXISTS observation_pending ON observations(counted, settle_at);
      CREATE TABLE IF NOT EXISTS pending_counts (generation INTEGER NOT NULL, arm_id TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(generation, arm_id));
      CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS release_generation ON releases(generation);
    `);
  }
  async apply(siteId: string, observation: Observation): Promise<boolean> {
    id(siteId, 'siteId');
    invariant(observation.endAt >= Date.now() - RETENTION_MS, 'outside_retention', 'Observation correction is older than 60 days');
    invariant(observation.status !== 'complete' || observation.endAt <= Date.now(), 'invalid_input', 'Cannot learn from an unfinished observation');
    const identity = { siteId, experimentId: observation.experimentId, shard: observationShard(observation.subjectKey) };
    const configKey = `settings:${observation.generation}`;
    const config = this.kv.get<ExperimentSettings>(configKey)
      ?? await this.env.EXPERIMENTS.getByName(experimentKey(siteId, observation.experimentId)).getGeneration(observation.generation);
    await this.wakeAt(Math.min(Date.now() + 60_000, Math.max(Date.now() + 1000, observation.endAt + config.allowedLatenessMs)));
    return this.atomic(() => {
      const known = this.kv.get<ShardIdentity>('identity');
      invariant(!known || JSON.stringify(known) === JSON.stringify(identity), 'conflict', 'Statistics shard identity mismatch');
      if (!known) this.kv.put('identity', identity);
      const oldRow = this.sql.exec<ObservationRow>('SELECT revision, counted, data FROM observations WHERE id = ?', observation.observationId).toArray()[0];
      if (oldRow && oldRow.revision >= observation.revision) return false;
      const old = oldRow ? storedJson<Observation>(oldRow.data) : undefined;
      if (old) invariant(old.generation === observation.generation && old.armId === observation.armId && old.endAt === observation.endAt, 'conflict', 'Observation identity and time range cannot change on revision');
      const now = Date.now(), settleAt = observation.endAt + config.allowedLatenessMs;
      // Pending rewards are not learned samples. Age moments on publish/read, and
      // persist them only when a completed contribution is added or retracted.
      if (old?.status === 'complete' || observation.status === 'complete') {
        const key = `moment:${observation.generation}:${JSON.stringify(observation.armId)}`;
        let moments = ageMoments(this.kv.get<Moments>(key) ?? emptyMoments(now), now, config.learningHalfLifeMs);
        const weight = decayFactor(Math.max(0, now - observation.endAt), config.learningHalfLifeMs);
        if (old?.status === 'complete') moments = removeSample(moments, old.reward, weight);
        if (observation.status === 'complete') moments = addSample(moments, observation.reward, weight);
        this.kv.put(key, moments);
      }
      const counted = observation.status === 'pending' && settleAt > now ? 1 : 0;
      this.changePending(observation, counted - (oldRow?.counted ?? 0));
      // Generation settings are immutable. Recheck after awaits for concurrent fills.
      if (!this.kv.get<ExperimentSettings>(configKey)) this.kv.put(configKey, config);
      this.markDirty(observation.generation);
      this.sql.exec('INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, counted = excluded.counted, data = excluded.data', observation.observationId, observation.revision, observation.endAt + RETENTION_MS, settleAt, counted, JSON.stringify(observation));
      this.sql.exec('INSERT OR IGNORE INTO releases VALUES (?, ?)', observation.assignmentId, observation.generation);
      return true;
    });
  }
  private markDirty(generation: number): void {
    this.kv.put(`dirty:${generation}`, true);
    this.kv.put('sequence', (this.kv.get<number>('sequence') ?? 0) + 1);
  }
  private changePending(observation: Observation, delta: number): void {
    if (delta === 0) return;
    this.sql.exec('INSERT INTO pending_counts VALUES (?, ?, ?) ON CONFLICT(generation, arm_id) DO UPDATE SET count = count + excluded.count', observation.generation, observation.armId, delta);
  }
  private expirePending(): void {
    for (const row of this.sql.exec<{ id: string; data: string }>('SELECT id, data FROM observations WHERE counted = 1 AND settle_at <= ? LIMIT 1000', Date.now()).toArray()) {
      const observation = storedJson<Observation>(row.data);
      this.changePending(observation, -1);
      this.sql.exec('UPDATE observations SET counted = 0 WHERE id = ?', row.id);
      this.markDirty(observation.generation);
    }
  }
  async publish(): Promise<void> {
    const identity = this.kv.get<ShardIdentity>('identity');
    if (!identity) return;
    this.atomic(() => this.expirePending());
    const dirty = [...this.kv.list<boolean>({ prefix: 'dirty:' })].map(([key]) => key);
    for (const key of dirty) {
      const sequence = this.kv.get<number>('sequence') ?? 0;
      const generation = Number(key.slice('dirty:'.length));
      const entries: [string, Moments][] = [];
      const prefix = `moment:${generation}:`, asOf = Date.now();
      const config = this.kv.get<ExperimentSettings>(`settings:${generation}`)!;
      for (const [key, m] of this.kv.list<Moments>({ prefix })) entries.push([storedJson<string>(key.slice(prefix.length)), ageMoments(m, asOf, config.learningHalfLifeMs)]);
      const pending = Object.fromEntries(this.sql.exec<{ arm_id: string; count: number }>('SELECT arm_id, count FROM pending_counts WHERE generation = ?', generation).toArray().map(r => [r.arm_id, r.count]));
      const releaseReservations = this.sql.exec<{ id: string }>('SELECT id FROM releases WHERE generation = ? LIMIT 1000', generation).toArray().map(r => r.id);
      const snapshot: ShardSnapshot = { generation, shard: identity.shard, sequence, asOf, moments: Object.fromEntries(entries), pending, releaseReservations };
      await this.env.EXPERIMENTS.getByName(experimentKey(identity.siteId, identity.experimentId)).acceptSnapshot(snapshot);
      this.atomic(() => {
        for (const id of releaseReservations) this.sql.exec('DELETE FROM releases WHERE id = ?', id);
        const remaining = this.sql.exec('SELECT id FROM releases WHERE generation = ? LIMIT 1', generation).toArray().length > 0;
        if (!remaining && this.kv.get<number>('sequence') === sequence) this.kv.delete(key);
      });
    }
  }
  override async alarm(): Promise<void> {
    this.alarmStarted();
    await this.wakeAt(Date.now() + 60_000);
    await this.publish();
    this.sql.exec('DELETE FROM observations WHERE id IN (SELECT id FROM observations WHERE expires_at <= ? LIMIT 1000)', Date.now());
    if ([...this.kv.list({ prefix: 'dirty:', limit: 1 })].length > 0) return;
    const expiry = this.sql.exec<{ at: number | null }>('SELECT MIN(expires_at) AS at FROM observations').one().at;
    const settlement = this.sql.exec<{ at: number | null }>('SELECT MIN(settle_at) AS at FROM observations WHERE counted = 1').one().at;
    const next = Math.min(expiry ?? Infinity, settlement ?? Infinity);
    if (Number.isFinite(next)) {
      const at = Math.max(Date.now() + 1000, next);
      const alarm = this.ctx.storage.setAlarm(at); this.kv.put('alarmAt', at); await alarm;
    } else {
      const alarm = this.ctx.storage.deleteAlarm(); this.kv.delete('alarmAt'); await alarm;
    }
  }
}
