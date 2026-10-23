import type { RuntimeEnv as Env } from './environment.generated.js';
import { analyticsRecord } from '../analytics/records.js';
import { exportRecords, exportBatches } from '../analytics/export.js';
import type { AnalyticsRecord, RecordContext } from '../analytics/records.js';
import { attributeGoal, compareIdentifiers } from '../core/attribution.js';
import { finite, invariant } from '../core/errors.js';
import { parseEnvelope } from '../core/events.js';
import { canReassign, closeObservation, interruptObservation } from '../core/observation.js';
import { projectExperiment, projectExposure } from '../core/projection.js';
import type { AssignmentLifetime } from '../core/projection.js';
import type { Assignment, Credit, Decision, EventEnvelope, Exposure, ExposureEvent, GoalEvent, Observation, Subject } from '../core/types.js';
import { experimentKey, id, RETENTION_MS, subjectKey as makeSubjectKey } from '../core/validation.js';
import { StoredObject, storedJson } from './base.js';
import { observationShard, shardKey } from './shard.js';

type DataRow = { data: string };
type Intent = { revision: number; requestId: string; requestedAt: number };
type AssignmentState = { revision: number; assignment: Assignment | null };
type Effect = { kind: 'observation'; observation: Observation } | { kind: 'export'; record: AnalyticsRecord } | { kind: 'release'; experimentId: string; assignmentId: string };
type EffectRow = { id: string; revision: number; data: string };
export type IngestResult = { status: 'accepted' | 'duplicate' | 'ignored'; eventId: string };

const TRANSFER_TABLES = ['assignments', 'events', 'exposures', 'observations', 'credits', 'outbox', 'origins', 'lineages'] as const;
type TransferTable = typeof TRANSFER_TABLES[number];
type TransferRow = Record<string, string | number | null>;
export interface SubjectTransfer {
  source: string; stateKey: string; at: number; subject: Subject;
  pins: { key: string; value: number }[]; states: AssignmentState[];
}

export class SubjectObject extends StoredObject {
  // Exists only during a synchronous transaction, never across an await.
  private observationChanges: Map<string, { context: RecordContext; observation: Observation }> | undefined;
  private coalesce<T>(fn: () => T): T {
    invariant(!this.observationChanges, 'conflict', 'Nested observation transaction');
    return this.atomic(() => {
      this.observationChanges = new Map();
      try {
        const result = fn();
        const changes = this.observationChanges;
        this.observationChanges = undefined;
        for (const { context, observation } of changes.values()) this.persistObservation(context, observation);
        return result;
      } finally { this.observationChanges = undefined; }
    });
  }
  private correctionExpired(observation: Observation): boolean {
    const lifetime = this.lifetime(observation.assignmentId);
    invariant(lifetime, 'conflict', 'Missing observation assignment');
    return Date.now() > observation.endAt + (lifetime.assignment.settings.correctionWindowMs ?? RETENTION_MS);
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS assignment_experiment ON assignments(experiment_id);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_kind_time ON events(kind, occurred_at, id);
      CREATE TABLE IF NOT EXISTS exposures (id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, assignment_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, observation_id TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS exposure_assignment ON exposures(assignment_id);
      CREATE INDEX IF NOT EXISTS exposure_expiry ON exposures(occurred_at);
      CREATE INDEX IF NOT EXISTS event_expiry ON events(occurred_at);
      CREATE INDEX IF NOT EXISTS exposure_time ON exposures(experiment_id, occurred_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, assignment_id TEXT NOT NULL, start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS observation_assignment ON observations(assignment_id, start_at DESC);
      CREATE INDEX IF NOT EXISTS observation_due ON observations(status, due_at);
      CREATE INDEX IF NOT EXISTS observation_expiry ON observations(end_at);
      CREATE INDEX IF NOT EXISTS observation_experiment ON observations(experiment_id, start_at);
      CREATE TABLE IF NOT EXISTS credits (goal_id TEXT NOT NULL, experiment_id TEXT NOT NULL, observation_id TEXT, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(goal_id, experiment_id));
      CREATE INDEX IF NOT EXISTS credit_observation ON credits(observation_id);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outbox_kind ON outbox(kind, revision);
      CREATE TABLE IF NOT EXISTS origins (kind TEXT NOT NULL, id TEXT NOT NULL, origin TEXT NOT NULL, PRIMARY KEY(kind, id));
      CREATE TABLE IF NOT EXISTS lineages (origin TEXT PRIMARY KEY, parent TEXT NOT NULL, joined_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS transfers (source TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS transfer_rows (source TEXT NOT NULL, table_name TEXT NOT NULL, row_id INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source, table_name, row_id));
      CREATE TABLE IF NOT EXISTS identity_events (id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL, uid TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS identity_event_time ON identity_events(occurred_at, id);
      CREATE TABLE IF NOT EXISTS identity_links (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
    `);
  }
  /** Freeze the source before copying. Every later event follows the durable redirect. */
  freezeTransfer(siteId: string, subject: Subject, source: string, target: string, at: number): SubjectTransfer {
    const existing = this.kv.get<{ target: string; transfer: SubjectTransfer }>('redirect');
    if (existing) { invariant(existing.target === target, 'conflict', 'Transfer target changed'); return existing.transfer; }
    this.context(siteId, { cid: subject.cid });
    const stateKey = this.ctx.id.toString();
    return this.atomic(() => {
      for (const row of this.sql.exec<{ id: string }>('SELECT id FROM assignments')) this.sql.exec("INSERT OR IGNORE INTO origins VALUES ('assignment', ?, ?)", row.id, stateKey);
      for (const row of this.sql.exec<{ id: string }>('SELECT id FROM events UNION SELECT id FROM exposures')) this.sql.exec("INSERT OR IGNORE INTO origins VALUES ('event', ?, ?)", row.id, stateKey);
      const transfer: SubjectTransfer = { source, stateKey, at, subject, pins: [...this.kv.list<number>({ prefix: 'lease-pin:' })].map(([key, value]) => ({ key, value })), states: [...this.kv.list<AssignmentState>({ prefix: 'experiment:' })].map(([, state]) => state) };
      this.kv.put('redirect', { target, transfer });
      return transfer;
    });
  }
  async transferTo(siteId: string, subject: Subject, source: string, targetName: string, at: number): Promise<void> {
    if (this.kv.get('transferReady') === true) return;
    await this.wakeAt(Date.now() + 1000);
    const metadata = this.freezeTransfer(siteId, subject, source, targetName, at);
    const target = this.env.SUBJECTS.getByName(targetName);
    for (const table of TRANSFER_TABLES) {
      const key = `transfer-cursor:${table}`;
      for (;;) {
        const cursor = this.kv.get<number>(key) ?? 0;
        const rows = this.sql.exec<TransferRow & { _row: number }>(`SELECT rowid AS _row, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT 50`, cursor).toArray();
        if (!rows.length) break;
        await target.stageTransfer(source, table, rows.map(({ _row, ...row }) => ({ id: _row, data: JSON.stringify(row) })));
        this.kv.put(key, Math.max(this.kv.get<number>(key) ?? 0, rows.at(-1)!._row));
      }
    }
    await target.acceptTransfer(siteId, metadata);
    this.atomic(() => {
      this.kv.put('transferReady', true);
      this.kv.put('redirect', { target: targetName, transfer: { ...metadata, states: [], pins: [] } });
    });
    await this.wakeAt(Date.now() + 1000);
  }
  stageTransfer(source: string, table: TransferTable, rows: { id: number; data: string }[]): void {
    invariant(TRANSFER_TABLES.includes(table) && rows.length <= 50, 'invalid_input', 'Invalid transfer page');
    if (this.sql.exec('SELECT source FROM transfers WHERE source = ?', source).toArray().length) return;
    this.atomic(() => { for (const row of rows) this.sql.exec('INSERT OR IGNORE INTO transfer_rows VALUES (?, ?, ?, ?)', source, table, row.id, row.data); });
  }
  private *stagedRows(source: string, table: TransferTable): Generator<TransferRow> {
    for (const row of this.sql.exec<DataRow>('SELECT data FROM transfer_rows WHERE source = ? AND table_name = ? ORDER BY row_id', source, table)) yield storedJson<TransferRow>(row.data);
  }
  async acceptTransfer(siteId: string, transfer: SubjectTransfer): Promise<void> {
    if (this.sql.exec('SELECT source FROM transfers WHERE source = ?', transfer.source).toArray().length) return;
    this.claimOwner(siteId, transfer.subject);
    const context = this.context(siteId, transfer.subject);
    await this.wakeAt(Date.now() + 1000);
    this.coalesce(() => {
      if (this.sql.exec('SELECT source FROM transfers WHERE source = ?', transfer.source).toArray().length) return;
      for (const { key, value } of transfer.pins) this.kv.put(key, Math.max(value, this.kv.get<number>(key) ?? 0));
      const conflicts: Assignment[] = [];
      for (const row of this.stagedRows(transfer.source, 'assignments')) {
        const key = `experiment:${String(row.experiment_id)}`;
        if (!this.kv.get(key)) this.kv.put(key, { revision: 0, assignment: null });
      }
      for (const state of transfer.states) {
        if (!state.assignment) continue;
        const before = this.state(state.assignment.experimentId);
        if (before.assignment) conflicts.push(state.assignment);
        else this.kv.put(`experiment:${state.assignment.experimentId}`, { revision: before.revision + 1, assignment: state.assignment });
      }
      // Copy immutable IDs and revisions. Shard contributions remain on their original subject key.
      for (const table of TRANSFER_TABLES) for (const row of this.stagedRows(transfer.source, table)) {
        if (table === 'outbox') {
          const effect = storedJson<Effect>(String(row.data));
          this.effect(String(row.id), effect);
          continue;
        }
        if (table === 'events' || table === 'exposures' || table === 'assignments') {
          const existing = this.sql.exec<DataRow>(`SELECT data FROM ${table} WHERE id = ?`, row.id!).toArray()[0];
          invariant(!existing || existing.data === row.data, 'conflict', 'Transfer contains conflicting record IDs');
        }
        const keys = Object.keys(row);
        this.sql.exec(`INSERT OR IGNORE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(key => row[key]!));
      }
      this.sql.exec('INSERT OR IGNORE INTO lineages VALUES (?, ?, ?)', transfer.stateKey, this.ctx.id.toString(), transfer.at);
      this.kv.put(`source-cid:${transfer.subject.cid}`, true);
      // Keep history for conflicting experiments too, but preserve uid's current assignment.
      for (const a of conflicts) this.retireAssignment(context, a, transfer.at, 'identity');
      for (const row of this.sql.exec<{ id: string }>("SELECT id FROM events WHERE kind = 'goal' AND status = 'accepted' AND occurred_at >= ?", transfer.at).toArray()) this.recalculateGoal(context, row.id);
      this.export(analyticsRecord(context, 'identity_links', `state-merge:${transfer.stateKey}`, 1, transfer.at, Date.now(),
        { sourceStateKey: transfer.stateKey, targetStateKey: this.ctx.id.toString(), joinedAt: transfer.at }, { status: 'merged' }));
      this.sql.exec('INSERT INTO transfers VALUES (?)', transfer.source);
      this.sql.exec('DELETE FROM transfer_rows WHERE source = ?', transfer.source);
    });
  }
  private origin(kind: string, id: string): string {
    return this.sql.exec<{ origin: string }>('SELECT origin FROM origins WHERE kind = ? AND id = ?', kind, id).toArray()[0]?.origin ?? this.ctx.id.toString();
  }
  private identityAt(origin: string, at: number): string {
    const seen = new Set<string>();
    while (!seen.has(origin)) {
      seen.add(origin);
      const link = this.sql.exec<{ parent: string; joined_at: number }>('SELECT parent, joined_at FROM lineages WHERE origin = ?', origin).toArray()[0];
      if (!link || link.joined_at > at) return origin;
      origin = link.parent;
    }
    throw new Error('Identity lineage cycle');
  }
  private async forwarded(): Promise<{ target: DurableObjectStub<SubjectObject>; origin: string } | null> {
    const redirect = this.kv.get<{ target: string; transfer: SubjectTransfer }>('redirect');
    if (!redirect) return null;
    const target = this.env.SUBJECTS.getByName(redirect.target);
    const context = this.kv.get<RecordContext>('identity')!;
    if (this.kv.get('transferReady') !== true) await this.transferTo(context.siteId, redirect.transfer.subject, redirect.transfer.source, redirect.target, redirect.transfer.at);
    return { target, origin: redirect.transfer.stateKey };
  }
  private context(siteId: string, subject: Subject): RecordContext {
    const owner = this.kv.get<{ uid: string; cid: string }>('owner');
    const context = owner ? { siteId, subjectKey: makeSubjectKey(siteId, { cid: subject.cid, uid: owner.uid }), cid: subject.cid, uid: owner.uid }
      : { siteId, subjectKey: makeSubjectKey(siteId, subject), ...subject };
    if (owner) invariant(subject.uid === owner.uid || (subject.uid === undefined && (subject.cid === owner.cid || this.kv.get(`source-cid:${subject.cid}`) === true)), 'conflict', 'Subject does not own this observation home');
    const old = this.kv.get<RecordContext>('identity');
    invariant(!old || old.subjectKey === context.subjectKey, 'conflict', 'Subject object identity mismatch');
    if (!old) this.kv.put('identity', context);
    return context;
  }
  /** A home has one authenticated owner for its lifetime; browser epochs never reuse it. */
  claimOwner(siteId: string, subject: Subject): void {
    invariant(subject.uid !== undefined, 'invalid_input', 'Claim requires uid');
    const owner = this.kv.get<{ uid: string; cid: string }>('owner');
    invariant(!owner || owner.uid === subject.uid, 'conflict', 'Observation home already has a different owner');
    const old = this.kv.get<RecordContext>('identity');
    invariant(!old || old.siteId === siteId, 'conflict', 'Observation home belongs to another site');
    if (owner && old?.subjectKey === makeSubjectKey(siteId, subject)) return;
    this.atomic(() => {
      if (!owner) this.kv.put('owner', { uid: subject.uid, cid: old?.cid ?? subject.cid });
      this.kv.put('identity', { siteId, subjectKey: makeSubjectKey(siteId, subject), ...subject });
    });
  }
  private state(experimentId: string): AssignmentState {
    return this.kv.get<AssignmentState>(`experiment:${experimentId}`) ?? { revision: 0, assignment: null };
  }
  peek(experimentId: string): Assignment | null { return this.state(experimentId).assignment; }
  private lifetime(assignmentId: string): AssignmentLifetime | undefined {
    const row = this.sql.exec<DataRow>('SELECT data FROM assignments WHERE id = ?', assignmentId).toArray()[0];
    return row ? storedJson<AssignmentLifetime>(row.data) : undefined;
  }
  private lastObservation(assignmentId: string): Observation | undefined {
    const row = this.sql.exec<DataRow>('SELECT data FROM observations WHERE assignment_id = ? ORDER BY start_at DESC LIMIT 1', assignmentId).toArray()[0];
    return row ? storedJson<Observation>(row.data) : undefined;
  }
  async decide(siteId: string, subject: Subject, experimentId: string, adopt?: Assignment): Promise<Decision> {
    const forwarding = await this.forwarded();
    if (forwarding) return forwarding.target.decide(siteId, subject, experimentId);
    id(siteId, 'siteId'); id(experimentId, 'experimentId');
    const context = this.context(siteId, subject);
    const experiment = this.env.EXPERIMENTS.getByName(experimentKey(siteId, experimentId));
    for (let attempt = 0; attempt < 4; attempt++) {
      const config = await experiment.getConfig();
      if (this.kv.get('redirect')) return this.decide(siteId, subject, experimentId);
      const before = this.state(experimentId), now = Date.now();
      const current = before.assignment;
      adopt ??= this.kv.get<Assignment>(`candidate:${experimentId}`);
      const active = (a: Assignment) => (config.status ?? 'active') === 'active' && config.arms.some(arm => arm.armId === a.armId && arm.status === 'active');
      if (current && active(current) && (!canReassign(current, this.lastObservation(current.assignmentId), now) || now < (this.kv.get<number>(`lease-pin:${current.assignmentId}`) ?? 0))) {
        return { status: 'assigned', assignment: current, reason: 'held' };
      }
      await this.wakeAt(Date.now() + 1000);
      if (this.kv.get('redirect')) return this.decide(siteId, subject, experimentId);
      if (this.state(experimentId).revision !== before.revision) continue;
      if (!current && adopt && active(adopt)) {
        const adopted = adopt;
        this.atomic(() => this.commitAssignment(context, before, adopted, 'adopted', now));
        return { status: 'assigned', assignment: adopted, reason: 'adopted' };
      }
      if ((config.status ?? 'active') !== 'active' || !config.arms.some(a => a.status === 'active')) {
        if (current) this.atomic(() => {
          this.retireAssignment(context, current, now, 'arm_stopped');
          this.kv.put(`experiment:${experimentId}`, { revision: before.revision + 1, assignment: null });
        });
        return { status: 'no_active_arm', experimentId };
      }
      const intentKey = `intent:${experimentId}`;
      let intent = this.kv.get<Intent>(intentKey);
      if (!intent || intent.revision !== before.revision || now >= intent.requestedAt + config.settings.reservationTtlMs) {
        intent = { revision: before.revision, requestId: crypto.randomUUID(), requestedAt: now };
        this.kv.put(intentKey, intent);
      }
      const assignment = await experiment.reserve(intent.requestId, intent.requestedAt);
      if (this.kv.get('redirect')) { if (assignment) await experiment.release(assignment.assignmentId); return this.decide(siteId, subject, experimentId); }
      const after = this.state(experimentId);
      if (after.revision !== before.revision) {
        // Another request committed. If it committed this same intent, it owns the reservation.
        if (assignment && after.assignment?.assignmentId !== assignment.assignmentId) this.effect(`release:${assignment.assignmentId}`, { kind: 'release', experimentId, assignmentId: assignment.assignmentId });
        continue;
      }
      if (!assignment) { this.kv.delete(intentKey); continue; }
      this.atomic(() => {
        this.commitAssignment(context, before, assignment, 'selected', Date.now());
        this.kv.delete(intentKey);
      });
      return { status: 'assigned', assignment, reason: 'selected' };
    }
    return { status: 'unavailable', experimentId };
  }
  async prepareReuse(siteId: string, subject: Subject, experimentId: string): Promise<{ decision: Decision; reuseUntil: number }> {
    const forwarding = await this.forwarded();
    if (forwarding) return forwarding.target.prepareReuse(siteId, subject, experimentId);
    const decision = await this.decide(siteId, subject, experimentId);
    if (this.kv.get('redirect')) return this.prepareReuse(siteId, subject, experimentId);
    if (decision.status !== 'assigned') return { decision, reuseUntil: 0 };
    if (this.state(experimentId).assignment?.assignmentId !== decision.assignment.assignmentId) return this.prepareReuse(siteId, subject, experimentId);
    const now = Date.now(), assignment = decision.assignment;
    const observation = this.lastObservation(assignment.assignmentId);
    if (observation && observation.endAt <= now && now < (this.kv.get<number>(`lease-pin:${assignment.assignmentId}`) ?? 0)
      && assignment.assignedAt + assignment.settings.minHoldMs <= now) return { decision: { status: 'unavailable', experimentId }, reuseUntil: 0 };
    const reuseUntil = Math.min(now + 300_000, observation?.status === 'pending' && observation.endAt > now ? observation.endAt : now + assignment.settings.observationWindowMs);
    // A queued exposure can arrive after another device prepares. Pin the assignment
    // through the latest possible window opened by this lease, without inventing an observation.
    const pin = observation?.status === 'pending' && observation.endAt > now ? observation.endAt : reuseUntil + assignment.settings.observationWindowMs;
    this.kv.put(`lease-pin:${assignment.assignmentId}`, Math.max(pin, this.kv.get<number>(`lease-pin:${assignment.assignmentId}`) ?? 0));
    return { decision, reuseUntil };
  }
  async recordHeldDecision(siteId: string, subject: Subject, assignment: Assignment, at: number): Promise<void> {
    const forwarding = await this.forwarded();
    if (forwarding) return forwarding.target.recordHeldDecision(siteId, subject, assignment, at);
    const context = this.context(siteId, subject);
    await this.wakeAt(Date.now() + 1000);
    if (this.kv.get('redirect')) return this.recordHeldDecision(siteId, subject, assignment, at);
    this.export(analyticsRecord(context, 'decisions', crypto.randomUUID(), 1, at, Date.now(),
      { assignment, reason: 'held', probability: 1, policyRevision: assignment.policyRevision },
      { experiment_id: assignment.experimentId, arm_id: assignment.armId, assignment_id: assignment.assignmentId }));
  }
  private commitAssignment(context: RecordContext, before: AssignmentState, assignment: Assignment, reason: 'selected' | 'adopted', now: number): void {
    if (before.assignment && before.assignment.assignmentId !== assignment.assignmentId) this.retireAssignment(context, before.assignment, now, before.assignment.generation !== assignment.generation ? 'configuration' : 'arm_stopped');
    this.kv.put(`experiment:${assignment.experimentId}`, { revision: before.revision + 1, assignment });
    this.kv.delete(`candidate:${assignment.experimentId}`);
    this.sql.exec('INSERT OR IGNORE INTO assignments VALUES (?, ?, ?)', assignment.assignmentId, assignment.experimentId, JSON.stringify({ assignment, retiredAt: null, reason: null } satisfies AssignmentLifetime));
    this.export(analyticsRecord(context, 'decisions', JSON.stringify([context.subjectKey, assignment.assignmentId]), 1, now, now, { assignment, reason, probability: reason === 'adopted' ? 1 : assignment.probability, policyRevision: assignment.policyRevision }, { experiment_id: assignment.experimentId, arm_id: assignment.armId, assignment_id: assignment.assignmentId }));
  }
  private retireAssignment(context: RecordContext, assignment: Assignment, at: number, reason: NonNullable<Observation['interruptReason']>): void {
    const old = this.lifetime(assignment.assignmentId);
    if (!old || (old.retiredAt !== null && old.retiredAt <= at)) return;
    this.sql.exec('UPDATE assignments SET data = ? WHERE id = ?', JSON.stringify({ ...old, retiredAt: at, reason }), assignment.assignmentId);
    for (const row of this.sql.exec<DataRow>('SELECT data FROM observations WHERE assignment_id = ? AND end_at > ?', assignment.assignmentId, at).toArray()) {
      const observation = storedJson<Observation>(row.data);
      const next = at <= observation.startAt ? { ...observation, status: 'interrupted' as const, interruptReason: reason } : interruptObservation(observation, at, reason);
      if (next !== observation) {
        this.saveObservation(context, next);
        for (const row of this.sql.exec<{ goal_id: string }>('SELECT goal_id FROM credits WHERE observation_id = ?', observation.observationId).toArray()) this.recalculateGoal(context, row.goal_id);
      }
    }
    this.effect(`release:${assignment.assignmentId}`, { kind: 'release', experimentId: assignment.experimentId, assignmentId: assignment.assignmentId });
  }
  /** Called on the anonymous object at a known login/logout boundary. */
  async interrupt(siteId: string, subject: Subject, occurredAt: number, experimentId?: string): Promise<void> {
    if (this.kv.get('redirect')) return;
    const context = this.context(siteId, subject);
    await this.wakeAt(Date.now() + 1000);
    if (this.kv.get('redirect')) return;
    this.atomic(() => {
      for (const [key, state] of this.kv.list<AssignmentState>({ prefix: 'experiment:' })) {
        if (!state.assignment || state.assignment.assignedAt > occurredAt || (experimentId !== undefined && state.assignment.experimentId !== experimentId)) continue;
        this.retireAssignment(context, state.assignment, occurredAt, 'identity');
        this.kv.put(key, { revision: state.revision + 1, assignment: null });
      }
    });
  }
  listAssignments(): Assignment[] {
    return [...this.kv.list<AssignmentState>({ prefix: 'experiment:' })].flatMap(([, state]) => state.assignment ? [state.assignment] : []);
  }
  offerAssignments(siteId: string, subject: Subject, assignments: readonly Assignment[]): void {
    this.context(siteId, subject);
    invariant(subject.uid !== undefined, 'invalid_input', 'Adoption candidates require uid');
    this.atomic(() => {
      for (const assignment of assignments) {
        const key = `candidate:${assignment.experimentId}`;
        if (!this.state(assignment.experimentId).assignment && !this.kv.get(key)) this.kv.put(key, assignment);
      }
    });
  }
  /** Anonymous browser object owns explicit login intervals; uid objects never become browser aliases. */
  async linkIdentity(input: EventEnvelope, automatic = false): Promise<void> {
    const envelope = parseEnvelope(input, Date.now()), event = envelope.event;
    invariant(event.kind === 'identify' || event.kind === 'logout', 'invalid_input', 'Expected identity event');
    const context = this.context(envelope.siteId, { cid: event.subject.cid });
    const uid = event.kind === 'identify' ? event.subject.uid! : null;
    if (automatic && this.kv.get<string | null>('linkedUid') === uid && event.occurredAt >= (this.kv.get<number>('lastIdentityAt') ?? 0)) return;
    await this.wakeAt(Date.now() + 1000);
    this.atomic(() => {
      const prior = this.sql.exec<DataRow>('SELECT data FROM identity_events WHERE id = ?', event.eventId).toArray()[0];
      if (prior) { invariant(prior.data === JSON.stringify(event), 'conflict', 'Identity event ID was reused'); return; }
      this.sql.exec('INSERT INTO identity_events VALUES (?, ?, ?, ?)', event.eventId, event.occurredAt, uid, JSON.stringify(event));
      const transitions = this.sql.exec<{ id: string; occurred_at: number; uid: string | null }>('SELECT id, occurred_at, uid FROM identity_events ORDER BY occurred_at, id').toArray();
      type Link = { linkId: string; cid: string; uid: string; linkedFrom: number; linkedUntil: number | null; status: 'active' | 'superseded' };
      const links: Link[] = [];
      let previous: Link | undefined;
      let activeUid: string | null = null;
      for (const transition of transitions) {
        if (transition.uid === activeUid) continue;
        if (previous) previous.linkedUntil = transition.occurred_at;
        activeUid = transition.uid;
        previous = activeUid === null ? undefined : { linkId: transition.id, cid: event.subject.cid, uid: activeUid, linkedFrom: transition.occurred_at, linkedUntil: null, status: 'active' };
        if (previous) links.push(previous);
      }
      const desired = new Map(links.map(link => [link.linkId, link]));
      const existing = this.sql.exec<{ id: string; revision: number; data: string }>('SELECT * FROM identity_links').toArray();
      for (const row of existing) if (!desired.has(row.id)) desired.set(row.id, { ...storedJson<Link>(row.data), status: 'superseded' });
      const old = new Map(existing.map(row => [row.id, row]));
      for (const [id, link] of desired) {
        const previous = old.get(id), data = JSON.stringify(link);
        if (previous?.data === data) continue;
        const revision = (previous?.revision ?? 0) + 1;
        this.sql.exec('INSERT INTO identity_links VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, data = excluded.data', id, revision, data);
        this.export(analyticsRecord({ ...context, uid: link.uid }, 'identity_links', id, revision, link.linkedFrom, envelope.receivedAt, link, { status: link.status }));
      }
      this.kv.put('linkedUid', activeUid);
      this.kv.put('lastIdentityAt', transitions.at(-1)?.occurred_at ?? 0);
      this.export(analyticsRecord({ ...context, ...event.subject }, 'events', event.eventId, 1, event.occurredAt, envelope.receivedAt, event, { status: 'accepted' }, event.attributes));
    });
  }
  async ingest(input: EventEnvelope, origin?: string): Promise<IngestResult> {
    const forwarding = await this.forwarded();
    if (forwarding) return forwarding.target.ingest(input, origin ?? forwarding.origin);
    const envelope = parseEnvelope(input, Date.now()), event = envelope.event;
    const context = this.context(envelope.siteId, event.subject);
    invariant(event.kind !== 'identify' && event.kind !== 'logout', 'invalid_input', 'Identity events are coordinated by the service entrypoint');
    const status = event.kind === 'goal'
      ? await this.env.SITES.getByName(envelope.siteId).goalStatusAt(event.goalId, event.occurredAt) === 'active' ? 'accepted' : 'ignored'
      : 'accepted';
    await this.wakeAt(Date.now() + 1000);
    if (this.kv.get('redirect')) return this.ingest(input, origin);
    return this.coalesce(() => this.ingestPrepared(envelope, context, status, origin));
  }
  /** Goals in one Queue group share one durable transaction and final observation writes. */
  async ingestGoals(inputs: readonly EventEnvelope[], origin?: string): Promise<IngestResult[]> {
    const forwarding = await this.forwarded();
    if (forwarding) return forwarding.target.ingestGoals(inputs, origin ?? forwarding.origin);
    invariant(inputs.length > 0 && inputs.length <= 100, 'invalid_input', 'Expected 1–100 goals');
    const envelopes = inputs.map(input => parseEnvelope(input, Date.now()));
    const first = envelopes[0]!;
    for (const envelope of envelopes) invariant(envelope.siteId === first.siteId
      && JSON.stringify(envelope.event.subject) === JSON.stringify(first.event.subject)
      && envelope.event.kind === 'goal', 'invalid_input', 'Goal batch must have one site and subject');
    const context = this.context(first.siteId, first.event.subject);
    const statuses: ('accepted' | 'ignored')[] = [];
    const known = new Map<string, 'accepted' | 'ignored'>();
    // Reuse identical historical lookups and keep one Site RPC in flight per
    // consumer task, rather than multiplying the outer concurrency bound by 100.
    for (const envelope of envelopes) {
      invariant(envelope.event.kind === 'goal', 'invalid_input', 'Expected goal');
      const key = JSON.stringify([envelope.event.goalId, envelope.event.occurredAt]);
      let status = known.get(key);
      if (status === undefined) {
        status = await this.env.SITES.getByName(envelope.siteId).goalStatusAt(envelope.event.goalId, envelope.event.occurredAt) === 'active' ? 'accepted' : 'ignored';
        known.set(key, status);
      }
      statuses.push(status);
    }
    await this.wakeAt(Date.now() + 1000);
    if (this.kv.get('redirect')) return this.ingestGoals(inputs, origin);
    return this.coalesce(() => envelopes.map((envelope, i) => this.ingestPrepared(envelope, context, statuses[i]!, origin)));
  }
  private ingestPrepared(envelope: EventEnvelope, context: RecordContext, status: 'accepted' | 'ignored', origin?: string): IngestResult {
    const event = envelope.event;
    const old = this.sql.exec<DataRow>('SELECT data FROM events WHERE id = ? UNION ALL SELECT data FROM exposures WHERE id = ? LIMIT 1', event.eventId, event.eventId).toArray()[0];
    if (old) {
      invariant(old.data === JSON.stringify(event), 'conflict', 'An event ID cannot be reused with different data');
      return { status: 'duplicate', eventId: event.eventId };
    }
    if (origin) this.sql.exec("INSERT OR IGNORE INTO origins VALUES ('event', ?, ?)", event.eventId, origin);
    // General logs need no online learning ledger. Analytics deduplicates immutable event IDs.
    if (event.kind !== 'track' && event.kind !== 'exposure') this.sql.exec('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)', event.eventId, event.kind, event.occurredAt, envelope.receivedAt, status, JSON.stringify(event));
    if (event.kind === 'exposure') this.ingestExposure(context, event);
    if (event.kind === 'goal' && status === 'accepted') this.recalculateGoal(context, event.eventId);
    this.export(analyticsRecord({ siteId: context.siteId, subjectKey: context.subjectKey, ...event.subject }, 'events', event.eventId, 1, event.occurredAt, envelope.receivedAt, { ...event, processingStatus: status }, {
      status, ...(event.kind === 'goal' ? { goal_id: event.goalId, value: event.value } : {}),
      ...(event.kind === 'exposure' ? { experiment_id: event.assignment.experimentId, arm_id: event.assignment.armId, assignment_id: event.assignment.assignmentId } : {}),
    }, event.attributes));
    return { status, eventId: event.eventId };
  }
  private ingestExposure(context: RecordContext, event: ExposureEvent): void {
    const lifetime = this.lifetime(event.assignment.assignmentId);
    invariant(lifetime && JSON.stringify(lifetime.assignment) === JSON.stringify(event.assignment), 'conflict', 'Exposure references an unknown or modified assignment');
    const last = this.sql.exec<{ occurred_at: number; id: string }>('SELECT occurred_at, id FROM exposures WHERE experiment_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1', event.assignment.experimentId).toArray()[0];
    const insert = (observationId: string | null) => this.sql.exec('INSERT INTO exposures VALUES (?, ?, ?, ?, ?, ?)', event.eventId, event.assignment.experimentId, event.assignment.assignmentId, event.occurredAt, observationId, JSON.stringify(event));
    if (last && (event.occurredAt < last.occurred_at || (event.occurredAt === last.occurred_at && compareIdentifiers(event.eventId, last.id) < 0))) {
      insert(null);
      this.rebuildExperiment(context, event.assignment.experimentId);
    } else {
      const previous = this.lastObservation(event.assignment.assignmentId);
      const result = projectExposure(event, lifetime, context.subjectKey, Date.now(), previous);
      if (result.observation && result.opened) this.saveObservation(context, result.observation);
      insert(result.observation?.observationId ?? null);
    }
    // A goal can arrive before its exposure even when exposures themselves are ordered.
    for (const row of this.sql.exec<{ id: string }>("SELECT id FROM events WHERE kind = 'goal' AND status = 'accepted' AND occurred_at >= ? ORDER BY occurred_at, id", event.occurredAt).toArray()) this.recalculateGoal(context, row.id);
  }
  private rebuildExperiment(context: RecordContext, experimentId: string): void {
    const lifetimes = new Map<string, AssignmentLifetime>();
    for (const row of this.sql.exec<DataRow>('SELECT data FROM assignments WHERE experiment_id = ?', experimentId)) {
      const lifetime = storedJson<AssignmentLifetime>(row.data); lifetimes.set(lifetime.assignment.assignmentId, lifetime);
    }
    const events = this.sql.exec<DataRow>('SELECT data FROM exposures WHERE experiment_id = ? ORDER BY occurred_at, id', experimentId).toArray().map(r => storedJson<ExposureEvent>(r.data));
    const frozen = this.sql.exec<DataRow>('SELECT data FROM observations WHERE experiment_id = ?', experimentId).toArray()
      .map(row => storedJson<Observation>(row.data)).filter(o => this.correctionExpired(o));
    const frozenEnd = new Map<string, number>();
    for (const o of frozen.filter(o => o.status !== 'interrupted')) frozenEnd.set(o.assignmentId, Math.max(frozenEnd.get(o.assignmentId) ?? -Infinity, o.endAt));
    const isFrozen = (e: ExposureEvent) => e.occurredAt < (frozenEnd.get(e.assignment.assignmentId) ?? -Infinity);
    const projection = projectExperiment(events.filter(e => !isFrozen(e)), lifetimes, context.subjectKey, Date.now());
    projection.observations.unshift(...frozen);
    for (const event of events.filter(isFrozen)) {
      const observation = frozen.find(o => o.status !== 'interrupted' && o.assignmentId === event.assignment.assignmentId && o.startAt <= event.occurredAt && event.occurredAt < o.endAt);
      projection.exposures.push({ event, observationId: observation?.observationId ?? null });
    }
    const ids = new Set(projection.observations.map(o => o.observationId));
    for (const row of this.sql.exec<DataRow>('SELECT data FROM observations WHERE experiment_id = ?', experimentId).toArray()) {
      const old = storedJson<Observation>(row.data);
      if (old.endAt < Date.now() - RETENTION_MS) continue;
      if (!ids.has(old.observationId) && old.status !== 'interrupted') this.saveObservation(context, { ...old, status: 'interrupted', interruptReason: 'configuration' });
    }
    for (const observation of projection.observations) {
      if (observation.endAt < Date.now() - RETENTION_MS) continue;
      const old = this.observation(observation.observationId);
      this.saveObservation(context, { ...observation, reward: old?.reward ?? 0 });
    }
    for (const exposure of projection.exposures) this.sql.exec('UPDATE exposures SET observation_id = ? WHERE id = ? AND observation_id IS NOT ?', exposure.observationId, exposure.event.eventId, exposure.observationId);
  }
  private observation(observationId: string): Observation | undefined {
    const staged = this.observationChanges?.get(observationId);
    if (staged) return staged.observation;
    const row = this.sql.exec<DataRow>('SELECT data FROM observations WHERE id = ?', observationId).toArray()[0];
    return row ? storedJson<Observation>(row.data) : undefined;
  }
  private recalculateGoal(context: RecordContext, goalId: string): void {
    const row = this.sql.exec<DataRow>("SELECT data FROM events WHERE id = ? AND kind = 'goal' AND status = 'accepted'", goalId).toArray()[0];
    if (!row) return;
    const goal = storedJson<GoalEvent>(row.data);
    const exposures: Exposure[] = [], observations = new Map<string, Observation>();
    for (const [key] of this.kv.list<AssignmentState>({ prefix: 'experiment:' })) {
      // Retired assignments remain in the SQL history; the key itself never expires with a hold.
      const experimentId = key.slice('experiment:'.length);
      const goalIdentity = this.identityAt(this.origin('event', goalId), goal.occurredAt);
      let last: { data: string; observation_id: string | null; assignment_id: string } | undefined;
      // Stop at the first eligible last touch. Do not materialize a user's retained history.
      for (const candidate of this.sql.exec<{ data: string; observation_id: string | null; assignment_id: string }>('SELECT data, observation_id, assignment_id FROM exposures WHERE experiment_id = ? AND occurred_at <= ? ORDER BY occurred_at DESC, id DESC', experimentId, goal.occurredAt)) {
        if (this.identityAt(this.origin('assignment', candidate.assignment_id), goal.occurredAt) === goalIdentity) { last = candidate; break; }
      }
      if (!last) continue;
      const exposure = storedJson<ExposureEvent>(last.data);
      exposures.push({ eventId: exposure.eventId, occurredAt: exposure.occurredAt, assignment: exposure.assignment, observationId: last.observation_id });
      if (last.observation_id) { const observation = this.observation(last.observation_id); if (observation) observations.set(last.observation_id, observation); }
    }
    const credits = attributeGoal(goal, exposures, observations).map(credit => {
      const observation = credit.observationId ? observations.get(credit.observationId) : undefined;
      return { ...credit, learningClosed: observation !== undefined && this.correctionExpired(observation) };
    });
    const oldCredits = new Map(this.sql.exec<{ experiment_id: string; revision: number; data: string }>('SELECT experiment_id, revision, data FROM credits WHERE goal_id = ?', goalId).toArray().map(r => [r.experiment_id, { credit: storedJson<Credit>(r.data), revision: r.revision }]));
    for (const credit of credits) {
      const old = oldCredits.get(credit.experimentId);
      if (old && JSON.stringify(old.credit) === JSON.stringify(credit)) continue;
      const deltas = new Map<string, number>();
      if (old?.credit.learningEligible && old.credit.observationId) deltas.set(old.credit.observationId, -old.credit.value);
      if (credit.learningEligible && credit.observationId) deltas.set(credit.observationId, (deltas.get(credit.observationId) ?? 0) + credit.value);
      for (const [observationId, delta] of deltas) if (delta !== 0) this.adjustReward(context, observationId, delta);
      const revision = (old?.revision ?? 0) + 1;
      this.sql.exec('INSERT INTO credits VALUES (?, ?, ?, ?, ?) ON CONFLICT(goal_id, experiment_id) DO UPDATE SET observation_id = excluded.observation_id, revision = excluded.revision, data = excluded.data', goalId, credit.experimentId, credit.observationId, revision, JSON.stringify(credit));
      this.export(analyticsRecord({ siteId: context.siteId, subjectKey: context.subjectKey, ...goal.subject }, 'credits', JSON.stringify([goalId, credit.experimentId]), revision, goal.occurredAt, Date.now(), credit, {
        experiment_id: credit.experimentId, arm_id: credit.armId, goal_id: goal.goalId, assignment_id: credit.assignmentId,
        observation_id: credit.observationId, value: credit.value, status: credit.learningEligible ? 'eligible' : 'outside_observation',
      }));
    }
  }
  private adjustReward(context: RecordContext, observationId: string, delta: number): void {
    const observation = this.observation(observationId);
    invariant(observation, 'conflict', 'Missing observation for credit');
    if (!this.correctionExpired(observation)) this.saveObservation(context, { ...observation, reward: finite(observation.reward + delta, 'Observation reward') });
  }
  private saveObservation(context: RecordContext, candidate: Observation): void {
    const old = this.observation(candidate.observationId);
    // Frozen windows retain their learned reward and boundaries. A delayed alarm
    // may still complete a pending window using its already accepted reward.
    if (old && this.correctionExpired(old)) {
      if (old.status !== 'pending' || candidate.status !== 'complete') return;
      candidate = { ...old, status: 'complete' };
    } else if (!old && this.correctionExpired(candidate)) {
      candidate = { ...candidate, status: 'interrupted', interruptReason: 'correction_expired', reward: 0 };
    }
    if (this.observationChanges) {
      this.observationChanges.set(candidate.observationId, { context, observation: candidate });
    } else this.persistObservation(context, candidate);
  }
  private persistObservation(context: RecordContext, candidate: Observation): void {
    const old = this.observation(candidate.observationId);
    if (old && old.status === candidate.status && old.reward === candidate.reward && old.interruptReason === candidate.interruptReason && JSON.stringify(old.attributes) === JSON.stringify(candidate.attributes)) return;
    if (old) invariant(old.assignmentId === candidate.assignmentId && old.startAt === candidate.startAt && old.endAt === candidate.endAt && old.generation === candidate.generation && old.armId === candidate.armId, 'conflict', 'Observation identity cannot change on revision');
    // Replaying history uses today's logical identity, but the revision ledger must
    // stay in the original shard. A new shard cannot retract the old contribution.
    const observation = { ...candidate, subjectKey: old?.subjectKey ?? candidate.subjectKey,
      ...(old?.subject ? { subject: old.subject } : {}), revision: (old?.revision ?? 0) + 1 };
    const lifetime = this.lifetime(observation.assignmentId);
    invariant(lifetime, 'conflict', 'Missing observation assignment');
    this.sql.exec('INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, revision = excluded.revision, data = excluded.data', observation.observationId, observation.experimentId, observation.assignmentId, observation.startAt, observation.endAt, observation.endAt + lifetime.assignment.settings.allowedLatenessMs, observation.status, observation.revision, JSON.stringify(observation));
    // Pending reward changes are not learned samples: send only lifecycle transitions.
    if (!old || old.status !== observation.status || observation.status === 'complete') {
      this.effect(`observation:${observation.observationId}`, { kind: 'observation', observation });
    }
    const original = observation.subject ? { siteId: context.siteId, subjectKey: context.subjectKey, ...observation.subject } : context;
    this.export(analyticsRecord(original, 'observations', observation.observationId, observation.revision, observation.startAt, Date.now(), observation, {
      experiment_id: observation.experimentId, arm_id: observation.armId, assignment_id: observation.assignmentId,
      observation_id: observation.observationId, status: observation.status, value: observation.reward,
    }, observation.attributes));
  }
  private effect(key: string, effect: Effect): void {
    const sequence = (this.kv.get<number>('outboxSequence') ?? 0) + 1;
    this.kv.put('outboxSequence', sequence);
    this.sql.exec('INSERT INTO outbox VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, data = excluded.data', key, sequence, effect.kind, JSON.stringify(effect));
  }
  private export(record: AnalyticsRecord): void {
    // The physical state home survives cid → uid adoption. Event-to-observation joins use
    // this key, while subject_key remains the identity known when the record was created.
    this.effect(`export:${record.table_name}:${record.record_id}`, { kind: 'export', record: { ...record, state_key: record.assignment_id ? this.origin('assignment', record.assignment_id) : this.ctx.id.toString() } });
  }
  async flush(): Promise<void> {
    if (this.kv.get('redirect')) return;
    const context = this.kv.get<RecordContext>('identity');
    if (!context) return;
    const rows = ['observation', 'release', 'export'].flatMap(kind => this.sql.exec<EffectRow>('SELECT id, revision, data FROM outbox WHERE kind = ? ORDER BY revision LIMIT 100', kind).toArray());
    const exported: { row: EffectRow; record: AnalyticsRecord }[] = [];
    const shards = new Set<string>();
    for (const row of rows) {
      const effect = storedJson<Effect>(row.data);
      if (effect.kind === 'export') { exported.push({ row, record: effect.record }); continue; }
      if (effect.kind === 'observation') {
        const key = shardKey(context.siteId, effect.observation.experimentId, observationShard(effect.observation.subjectKey));
        let expired = effect.observation.endAt < Date.now() - RETENTION_MS;
        if (!expired) {
          try {
            await this.env.OBSERVATIONS.getByName(key).apply(context.siteId, effect.observation);
            shards.add(key);
          } catch (error) {
            // The retention boundary can pass during the RPC. Other failures remain retryable.
            expired = typeof error === 'object' && error !== null && 'code' in error && error.code === 'outside_retention'
              && effect.observation.endAt < Date.now() - RETENTION_MS;
            if (!expired) throw error;
          }
        }
        if (expired) {
          await this.env.EXPERIMENTS.getByName(experimentKey(context.siteId, effect.observation.experimentId)).release(effect.observation.assignmentId);
          console.warn(JSON.stringify({ component: 'eye', operation: 'learning_export', code: 'outside_retention' }));
        }
      } else await this.env.EXPERIMENTS.getByName(experimentKey(context.siteId, effect.experimentId)).release(effect.assignmentId);
      this.sql.exec('DELETE FROM outbox WHERE id = ? AND revision = ?', row.id, row.revision);
    }
    // Publish statistics independently of the analytics sink's availability.
    for (const key of shards) await this.env.OBSERVATIONS.getByName(key).publish();
    if (exported.length > 0) {
      for (const batch of exportBatches(exported)) {
        await this.env.ANALYTICS.send(exportRecords(batch));
        this.atomic(() => { for (const { row } of batch) this.sql.exec('DELETE FROM outbox WHERE id = ? AND revision = ?', row.id, row.revision); });
      }
    }
  }
  private async cleanupTransferred(): Promise<void> {
    invariant(this.kv.get('transferReady') === true, 'conflict', 'Cannot reclaim an uncommitted transfer');
    this.atomic(() => {
      for (const table of TRANSFER_TABLES) this.sql.exec(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT 1000)`);
      let removed = 0;
      for (const [key] of this.kv.list()) {
        if (['identity', 'redirect', 'transferReady', 'alarmAt'].includes(key)) continue;
        this.kv.delete(key);
        if (++removed === 1000) break;
      }
    });
    const rowsRemain = TRANSFER_TABLES.some(table => this.sql.exec(`SELECT 1 FROM ${table} LIMIT 1`).toArray().length > 0);
    let keysRemain = false;
    for (const [key] of this.kv.list()) if (!['identity', 'redirect', 'transferReady', 'alarmAt'].includes(key)) { keysRemain = true; break; }
    if (rowsRemain || keysRemain) await this.wakeAt(Date.now() + 1000);
    else { await this.ctx.storage.deleteAlarm(); this.kv.delete('alarmAt'); }
  }
  private cleanup(now: number): void {
    const cutoff = now - RETENTION_MS;
    // Incrementally remove legacy duplicate exposure rows. The authoritative
    // exposure and its indexes remain; retries consult both tables during rollout.
    this.sql.exec("DELETE FROM events WHERE id IN (SELECT e.id FROM events e WHERE e.kind = 'exposure' AND EXISTS (SELECT 1 FROM exposures x WHERE x.id = e.id) LIMIT 1000)");
    const expired = this.sql.exec<{ id: string }>('SELECT id FROM events WHERE occurred_at < ? LIMIT 1000', cutoff).toArray();
    for (const row of expired) {
      this.sql.exec('DELETE FROM credits WHERE goal_id = ?', row.id);
      this.sql.exec('DELETE FROM events WHERE id = ?', row.id);
    }
    this.sql.exec('DELETE FROM observations WHERE id IN (SELECT id FROM observations WHERE end_at < ? LIMIT 1000)', cutoff);
    // Replaying a retained W-day observation may require its start up to W before the 60-day correction horizon.
    // Preserve one older last-touch anchor per experiment indefinitely; never remove it from K just because it is old.
    this.sql.exec(`DELETE FROM exposures WHERE id IN (
      SELECT e.id FROM exposures e WHERE e.occurred_at < ? AND EXISTS (
        SELECT 1 FROM exposures newer WHERE newer.experiment_id = e.experiment_id AND newer.occurred_at < ?
        AND (newer.occurred_at > e.occurred_at OR (newer.occurred_at = e.occurred_at AND newer.id > e.id))
      ) LIMIT 1000
    )`, now - 2 * RETENTION_MS, now - 2 * RETENTION_MS);
    this.sql.exec(`DELETE FROM identity_events WHERE id IN (
      SELECT e.id FROM identity_events e WHERE e.occurred_at < ? AND EXISTS (
        SELECT 1 FROM identity_events newer WHERE newer.occurred_at < ?
        AND (newer.occurred_at > e.occurred_at OR (newer.occurred_at = e.occurred_at AND newer.id > e.id))
      ) LIMIT 1000
    )`, cutoff, cutoff);
    this.sql.exec("DELETE FROM identity_links WHERE id IN (SELECT id FROM identity_links WHERE json_extract(data, '$.linkedUntil') < ? OR (json_extract(data, '$.status') = 'superseded' AND json_extract(data, '$.linkedFrom') < ?) LIMIT 1000)", cutoff, cutoff);
    const active = new Set([...this.kv.list<AssignmentState>({ prefix: 'experiment:' })].flatMap(([, state]) => state.assignment ? [state.assignment.assignmentId] : []));
    for (const row of this.sql.exec<{ id: string }>(`SELECT a.id FROM assignments a
      WHERE json_extract(a.data, '$.assignment.assignedAt') < ?
      AND NOT EXISTS (SELECT 1 FROM exposures e WHERE e.assignment_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.assignment_id = a.id) LIMIT 1000`, cutoff).toArray()) {
      if (!active.has(row.id)) this.sql.exec('DELETE FROM assignments WHERE id = ?', row.id);
    }
  }
  private nextMaintenance(): number | null {
    const events = this.sql.exec<{ at: number | null }>('SELECT MIN(occurred_at) AS at FROM events').one().at;
    const observations = this.sql.exec<{ at: number | null }>('SELECT MIN(end_at) AS at FROM observations').one().at;
    // An anchor is removable only once its chronological successor also leaves the replay horizon.
    let exposure: number | null = null;
    for (const [key] of this.kv.list({ prefix: 'experiment:' })) {
      const second = this.sql.exec<{ occurred_at: number }>('SELECT occurred_at FROM exposures WHERE experiment_id = ? ORDER BY occurred_at, id LIMIT 1 OFFSET 1', key.slice('experiment:'.length)).toArray()[0]?.occurred_at;
      if (second !== undefined) exposure = exposure === null ? second : Math.min(exposure, second);
    }
    const identity = this.sql.exec<{ occurred_at: number }>('SELECT occurred_at FROM identity_events ORDER BY occurred_at, id LIMIT 1 OFFSET 1').toArray()[0]?.occurred_at ?? null;
    const at = Math.min(events === null ? Infinity : events + RETENTION_MS + 1,
      observations === null ? Infinity : observations + RETENTION_MS + 1,
      exposure === null ? Infinity : exposure + 2 * RETENTION_MS + 1,
      identity === null ? Infinity : identity + RETENTION_MS + 1);
    return Number.isFinite(at) ? at : null;
  }
  override async alarm(): Promise<void> {
    this.alarmStarted();
    if (await this.forwarded()) { await this.cleanupTransferred(); return; }
    await this.wakeAt(Date.now() + 10_000);
    if (await this.forwarded()) { await this.cleanupTransferred(); return; }
    const context = this.kv.get<RecordContext>('identity');
    if (context) this.atomic(() => {
      for (const row of this.sql.exec<DataRow>("SELECT data FROM observations WHERE status = 'pending' AND due_at <= ? LIMIT 1000", Date.now()).toArray()) {
        const observation = storedJson<Observation>(row.data), lifetime = this.lifetime(observation.assignmentId)!;
        this.saveObservation(context, closeObservation(observation, Date.now(), lifetime.assignment.settings.allowedLatenessMs));
      }
    });
    await this.flush();
    if (this.sql.exec('SELECT id FROM outbox LIMIT 1').toArray().length > 0) { await this.wakeAt(Date.now() + 1000); return; }
    this.atomic(() => this.cleanup(Date.now()));
    const observationDue = this.sql.exec<{ at: number | null }>("SELECT MIN(due_at) AS at FROM observations WHERE status = 'pending'").one().at;
    const maintenance = this.nextMaintenance();
    const minimum = Math.min(observationDue ?? Infinity, maintenance ?? Infinity);
    const due = Number.isFinite(minimum) ? minimum : null;
    if (due !== null) {
      const at = Math.max(Date.now() + 1000, due), pending = this.ctx.storage.setAlarm(at);
      this.kv.put('alarmAt', at); await pending;
    } else {
      const pending = this.ctx.storage.deleteAlarm(); this.kv.delete('alarmAt'); await pending;
    }
  }
}
