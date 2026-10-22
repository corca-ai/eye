import type { RuntimeEnv as Env } from './environment.generated.js';
import { analyticsRecord } from '../analytics/records.js';
import { exportBatches } from '../analytics/export.js';
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

export class SubjectObject extends StoredObject {
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
      CREATE TABLE IF NOT EXISTS identity_events (id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL, uid TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS identity_event_time ON identity_events(occurred_at, id);
      CREATE TABLE IF NOT EXISTS identity_links (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
    `);
  }
  private context(siteId: string, subject: Subject): RecordContext {
    const owner = this.kv.get<{ uid: string; cid: string }>('owner');
    const context = owner ? { siteId, subjectKey: makeSubjectKey(siteId, { cid: subject.cid, uid: owner.uid }), cid: subject.cid, uid: owner.uid }
      : { siteId, subjectKey: makeSubjectKey(siteId, subject), ...subject };
    if (owner) invariant(subject.uid === owner.uid || (subject.uid === undefined && subject.cid === owner.cid), 'conflict', 'Subject does not own this observation home');
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
    id(siteId, 'siteId'); id(experimentId, 'experimentId');
    const context = this.context(siteId, subject);
    const experiment = this.env.EXPERIMENTS.getByName(experimentKey(siteId, experimentId));
    for (let attempt = 0; attempt < 4; attempt++) {
      const config = await experiment.getConfig();
      const before = this.state(experimentId), now = Date.now();
      const current = before.assignment;
      adopt ??= this.kv.get<Assignment>(`candidate:${experimentId}`);
      const active = (a: Assignment) => config.arms.some(arm => arm.armId === a.armId && arm.status === 'active');
      if (current && active(current) && !canReassign(current, this.lastObservation(current.assignmentId), now)) {
        return { status: 'assigned', assignment: current, reason: 'held' };
      }
      await this.wakeAt(Date.now() + 1000);
      if (this.state(experimentId).revision !== before.revision) continue;
      if (!current && adopt && active(adopt)) {
        const adopted = adopt;
        this.atomic(() => this.commitAssignment(context, before, adopted, 'adopted', now));
        return { status: 'assigned', assignment: adopted, reason: 'adopted' };
      }
      if (!config.arms.some(a => a.status === 'active')) {
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
  async recordHeldDecision(siteId: string, subject: Subject, assignment: Assignment, at: number): Promise<void> {
    const context = this.context(siteId, subject);
    await this.wakeAt(Date.now() + 1000);
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
    const context = this.context(siteId, subject);
    await this.wakeAt(Date.now() + 1000);
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
  async ingest(input: EventEnvelope): Promise<IngestResult> {
    const envelope = parseEnvelope(input, Date.now()), event = envelope.event;
    const context = this.context(envelope.siteId, event.subject);
    invariant(event.kind !== 'identify' && event.kind !== 'logout', 'invalid_input', 'Identity events are coordinated by the service entrypoint');
    const status = event.kind === 'goal'
      ? await this.env.SITES.getByName(envelope.siteId).goalStatusAt(event.goalId, event.occurredAt) === 'active' ? 'accepted' : 'ignored'
      : 'accepted';
    await this.wakeAt(Date.now() + 1000);
    return this.atomic(() => {
      const old = this.sql.exec<DataRow>('SELECT data FROM events WHERE id = ?', event.eventId).toArray()[0];
      if (old) {
        invariant(old.data === JSON.stringify(event), 'conflict', 'An event ID cannot be reused with different data');
        return { status: 'duplicate', eventId: event.eventId };
      }
      // General logs need no online learning ledger. Analytics deduplicates immutable event IDs.
      if (event.kind !== 'track') this.sql.exec('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)', event.eventId, event.kind, event.occurredAt, envelope.receivedAt, status, JSON.stringify(event));
      if (event.kind === 'exposure') this.ingestExposure(context, event);
      if (event.kind === 'goal' && status === 'accepted') this.recalculateGoal(context, event.eventId);
      this.export(analyticsRecord({ siteId: context.siteId, subjectKey: context.subjectKey, ...event.subject }, 'events', event.eventId, 1, event.occurredAt, envelope.receivedAt, { ...event, processingStatus: status }, {
        status, ...(event.kind === 'goal' ? { goal_id: event.goalId, value: event.value } : {}),
        ...(event.kind === 'exposure' ? { experiment_id: event.assignment.experimentId, arm_id: event.assignment.armId, assignment_id: event.assignment.assignmentId } : {}),
      }, event.attributes));
      return { status, eventId: event.eventId };
    });
  }
  private ingestExposure(context: RecordContext, event: ExposureEvent): void {
    const lifetime = this.lifetime(event.assignment.assignmentId);
    invariant(lifetime && JSON.stringify(lifetime.assignment) === JSON.stringify(event.assignment), 'conflict', 'Exposure references an unknown or modified assignment');
    const last = this.sql.exec<{ occurred_at: number; id: string }>('SELECT occurred_at, id FROM exposures WHERE experiment_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1', event.assignment.experimentId).toArray()[0];
    this.sql.exec('INSERT INTO exposures VALUES (?, ?, ?, ?, ?, ?)', event.eventId, event.assignment.experimentId, event.assignment.assignmentId, event.occurredAt, null, JSON.stringify(event));
    if (last && (event.occurredAt < last.occurred_at || (event.occurredAt === last.occurred_at && compareIdentifiers(event.eventId, last.id) < 0))) {
      this.rebuildExperiment(context, event.assignment.experimentId);
    } else {
      const previous = this.lastObservation(event.assignment.assignmentId);
      const result = projectExposure(event, lifetime, context.subjectKey, Date.now(), previous);
      if (result.observation && result.opened) this.saveObservation(context, result.observation);
      this.sql.exec('UPDATE exposures SET observation_id = ? WHERE id = ?', result.observation?.observationId ?? null, event.eventId);
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
    const projection = projectExperiment(events, lifetimes, context.subjectKey, Date.now());
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
    for (const exposure of projection.exposures) this.sql.exec('UPDATE exposures SET observation_id = ? WHERE id = ?', exposure.observationId, exposure.event.eventId);
  }
  private observation(observationId: string): Observation | undefined {
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
      const last = this.sql.exec<{ data: string; observation_id: string | null }>('SELECT data, observation_id FROM exposures WHERE experiment_id = ? AND occurred_at <= ? ORDER BY occurred_at DESC, id DESC LIMIT 1', experimentId, goal.occurredAt).toArray()[0];
      if (!last) continue;
      const exposure = storedJson<ExposureEvent>(last.data);
      exposures.push({ eventId: exposure.eventId, occurredAt: exposure.occurredAt, assignment: exposure.assignment, observationId: last.observation_id });
      if (last.observation_id) { const observation = this.observation(last.observation_id); if (observation) observations.set(last.observation_id, observation); }
    }
    const credits = attributeGoal(goal, exposures, observations);
    const oldCredits = new Map(this.sql.exec<{ experiment_id: string; revision: number; data: string }>('SELECT experiment_id, revision, data FROM credits WHERE goal_id = ?', goalId).toArray().map(r => [r.experiment_id, { credit: storedJson<Credit>(r.data), revision: r.revision }]));
    for (const credit of credits) {
      const old = oldCredits.get(credit.experimentId);
      if (old && JSON.stringify(old.credit) === JSON.stringify(credit)) continue;
      if (old?.credit.learningEligible && old.credit.observationId) this.adjustReward(context, old.credit.observationId, -old.credit.value);
      if (credit.learningEligible && credit.observationId) this.adjustReward(context, credit.observationId, credit.value);
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
    this.saveObservation(context, { ...observation, reward: finite(observation.reward + delta, 'Observation reward') });
  }
  private saveObservation(context: RecordContext, candidate: Observation): void {
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
    this.effect(`observation:${observation.observationId}`, { kind: 'observation', observation });
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
    this.effect(`export:${record.table_name}:${record.record_id}`, { kind: 'export', record: { ...record, state_key: this.ctx.id.toString() } });
  }
  async flush(): Promise<void> {
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
        await this.env.ANALYTICS.send(batch.map(e => e.record));
        this.atomic(() => { for (const { row } of batch) this.sql.exec('DELETE FROM outbox WHERE id = ? AND revision = ?', row.id, row.revision); });
      }
    }
  }
  private cleanup(now: number): void {
    const cutoff = now - RETENTION_MS;
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
    await this.wakeAt(Date.now() + 10_000);
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
