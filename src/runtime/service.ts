import { WorkerEntrypoint } from 'cloudflare:workers';
import type { RuntimeEnv as Env } from './environment.generated.js';
import { MAX_BATCH_BYTES, MAX_EVENT_BYTES, encodedSize } from '../client.js';
import { invariant } from '../core/errors.js';
import { parseEnvelope } from '../core/events.js';
import { experimentKey, id, subject as parseSubject, subjectKey } from '../core/validation.js';
import type { ArmStatus, CreateExperiment, Decision, EventEnvelope, ExperimentSettings, GoalStatus, Subject } from '../core/types.js';
import type { EyeService, PreparedDecision, PublishedPolicy } from '../transport.js';
import { identityKey } from './identity.js';
import { analyticsRecord, type AnalyticsRecord } from '../analytics/records.js';
import { exportRecords, exportBatches, validateExport } from '../analytics/export.js';
import { BasinAnalytics } from '../analytics/query.js';
import type { AnalyticsEnv } from '../analytics/query.js';
import type { AnalyticsAPI } from '../analytics/types.js';

export class EyeWorker extends WorkerEntrypoint<Env & AnalyticsEnv> implements EyeService {
  override fetch(): Response { return new Response('Not found', { status: 404 }); }
  async decide(siteId: string, input: Subject, experimentId: string): Promise<Decision> {
    id(siteId, 'siteId'); id(experimentId, 'experimentId');
    const subject = parseSubject(input);
    try {
      const home = await this.resolveHome(siteId, subject, Date.now());
      const target = this.env.SUBJECTS.getByName(home);
      const decision = await target.decide(siteId, subject, experimentId);
      if (decision.status === 'assigned' && decision.reason === 'held') {
        this.ctx.waitUntil(target.recordHeldDecision(siteId, subject, decision.assignment, Date.now()).catch(() => {
          console.warn(JSON.stringify({ component: 'eye', operation: 'held_decision_log', code: 'unavailable' }));
        }));
      }
      return decision.status === 'assigned' ? { ...decision, routingKey: home } : decision;
    } catch (error) {
      console.warn(JSON.stringify({ component: 'eye', operation: 'decide', code: errorCode(error) ?? 'unavailable' }));
      return { status: 'unavailable', experimentId };
    }
  }
  async getPublishedPolicy(siteId: string, experimentId: string): Promise<PublishedPolicy> { return this.experiment(siteId, experimentId).publishedPolicy(siteId); }
  async prepareDecision(siteId: string, input: Subject, experimentId: string): Promise<PreparedDecision> {
    id(siteId, 'siteId'); id(experimentId, 'experimentId');
    const subject = parseSubject(input), home = await this.resolveHome(siteId, subject, Date.now());
    const prepared = await this.env.SUBJECTS.getByName(home).prepareReuse(siteId, subject, experimentId);
    const decision = prepared.decision.status === 'assigned' ? { ...prepared.decision, routingKey: home } : prepared.decision;
    const policy = await this.getPublishedPolicy(siteId, experimentId);
    return { reuseUntil: prepared.reuseUntil, decision, policy };
  }
  async ingest(inputs: readonly EventEnvelope[]): Promise<void> {
    invariant(Array.isArray(inputs) && inputs.length <= 100, 'invalid_input', 'An ingestion batch must contain at most 100 events');
    const envelopes = inputs.map(input => parseEnvelope(input, Date.now()));
    const sizes = envelopes.map(e => encodedSize(e) + 200);
    invariant(sizes.every(size => size <= MAX_EVENT_BYTES) && sizes.reduce((a, b) => a + b, 0) <= MAX_BATCH_BYTES, 'invalid_input', 'Ingestion batch exceeds encoded size limits');
    if (envelopes.length > 0) await this.env.EVENTS.sendBatch(envelopes.map(body => ({ body, contentType: 'json' })));
  }
  override async queue(batch: MessageBatch<unknown>): Promise<void> {
    const work: { message: Message<unknown>; envelope: EventEnvelope }[] = [];
    for (const message of batch.messages) {
      try {
        const envelope = parseEnvelope(message.body, Date.now());
        invariant(encodedSize(envelope) + 200 <= MAX_EVENT_BYTES, 'invalid_input', 'Event exceeds the Queue envelope limit');
        work.push({ message, envelope });
      } catch (error) { this.consumeFailure(message, error); }
    }
    const tracks: { message: Message<unknown>; record: AnalyticsRecord }[] = [];
    let remainingTracks = work.filter(item => item.envelope.event.kind === 'track').length;
    let logsReady!: () => void;
    const ready = new Promise<void>(resolve => { logsReady = resolve; });
    if (remainingTracks === 0) logsReady();
    // Send as soon as log routing completes, without waiting for slower learning RPCs.
    const exporting = ready.then(() => this.exportTracks(tracks));
    let cursor = 0;
    const process = async () => {
      for (;;) {
        const item = work[cursor++];
        if (!item) return;
        const { message, envelope } = item;
        const isTrack = envelope.event.kind === 'track';
        // Combine only adjacent goals for the exact same subject, preserving
        // exposure/identity barriers and bounding the transaction by Queue batch size.
        const goals = [item];
        if (envelope.event.kind === 'goal') {
          while (work[cursor]?.envelope.event.kind === 'goal'
            && work[cursor]!.envelope.siteId === envelope.siteId
            && work[cursor]!.envelope.event.occurredAt === envelope.event.occurredAt
            && JSON.stringify(work[cursor]!.envelope.event.subject) === JSON.stringify(envelope.event.subject)) goals.push(work[cursor++]!);
        }
        try {
          if (isTrack) tracks.push({ message, record: await this.trackRecord(envelope) });
          else if (goals.length > 1) {
            try {
              const home = await this.resolveHome(envelope.siteId, envelope.event.subject, envelope.event.occurredAt);
              await this.env.SUBJECTS.getByName(home).ingestGoals(goals.map(item => item.envelope));
              for (const item of goals) item.message.ack();
            } catch {
              // One poison event must not discard valid neighbours. Atomic batch
              // rollback or durable event IDs make individual fallback safe.
              for (const item of goals) {
                try { await this.processEvent(item.envelope); item.message.ack(); }
                catch (error) { this.consumeFailure(item.message, error); }
              }
            }
          } else {
            await this.processEvent(envelope);
            message.ack();
          }
        } catch (error) { this.consumeFailure(message, error); }
        finally { if (isTrack && --remainingTracks === 0) logsReady(); }
      }
    };
    // Bound all routing/learning fan-out together, including mixed batches.
    await Promise.all([...Array.from({ length: Math.min(work.length, 8) }, process), exporting]);
  }
  private consumeFailure(message: Message<unknown>, error: unknown): void {
    const code = errorCode(error);
    console.warn(JSON.stringify({ component: 'eye', operation: 'consume', code: code ?? 'unavailable', messageId: message.id }));
    if (code === 'invalid_input' || code === 'outside_retention' || code === 'conflict') message.ack();
    else message.retry();
  }
  private async trackRecord({ siteId, receivedAt, event }: EventEnvelope): Promise<AnalyticsRecord> {
    invariant(event.kind === 'track', 'invalid_input', 'Expected a track event');
    // Preserve identity transitions and the physical cohort join key without a
    // Subject ingestion RPC, durable outbox, or per-log alarm.
    const home = await this.resolveHome(siteId, event.subject, event.occurredAt);
    const record = analyticsRecord({ siteId, subjectKey: subjectKey(siteId, event.subject), ...event.subject },
      'events', event.eventId, 1, event.occurredAt, receivedAt,
      { ...event, processingStatus: 'accepted' }, { status: 'accepted' }, event.attributes);
    record.state_key = this.env.SUBJECTS.idFromName(home).toString();
    validateExport(record);
    return record;
  }
  private async exportTracks(tracks: readonly { message: Message<unknown>; record: AnalyticsRecord }[]): Promise<void> {
    // Queue delivery already supplies the durable retry boundary for immutable
    // logs. Successful groups stay acknowledged if a later Stream send fails.
    for (const group of exportBatches(tracks)) {
      try {
        await this.env.ANALYTICS.send(exportRecords(group));
        for (const { message } of group) message.ack();
      } catch (error) {
        console.warn(JSON.stringify({ component: 'eye', operation: 'track_export', code: errorCode(error) ?? 'unavailable', count: group.length }));
        for (const { message } of group) message.retry();
      }
    }
  }
  private async resolveHome(siteId: string, subject: Subject, at: number, link = true): Promise<string> {
    const browser = this.env.IDENTITIES.getByName(identityKey(siteId, 'cid', subject.cid));
    if (subject.uid === undefined) return browser.anonymousHome(siteId, subject.cid, at);
    const candidate = await browser.takeForUid(siteId, subject.cid, subject.uid, at);
    const home = await this.env.IDENTITIES.getByName(identityKey(siteId, 'uid', subject.uid)).uidHome(siteId, subject.uid, candidate);
    await this.env.SUBJECTS.getByName(home).claimOwner(siteId, subject);
    if (candidate && candidate !== home) {
      await this.env.SUBJECTS.getByName(candidate).transferTo(siteId, subject, candidate, home, at);
    }
    const linkedAt = Date.now();
    // Timeline metadata stays on a distinct browser object and never becomes the uid's mutable state.
    const timeline = JSON.stringify([siteId, 'identity-timeline', subject.cid]);
    if (link) await this.env.SUBJECTS.getByName(timeline).linkIdentity({ siteId, receivedAt: linkedAt,
      event: { kind: 'identify', eventId: crypto.randomUUID(), occurredAt: at, subject } }, true);
    return home;
  }
  private async processEvent(envelope: EventEnvelope): Promise<void> {
    const { siteId, event } = envelope;
    if (event.kind === 'identify' || event.kind === 'logout') {
      if (event.kind === 'identify') await this.resolveHome(siteId, event.subject, event.occurredAt, false);
      else {
        const previous = await this.env.IDENTITIES.getByName(identityKey(siteId, 'cid', event.subject.cid)).logout(siteId, event.subject.cid, event.occurredAt);
        if (previous) await this.env.SUBJECTS.getByName(previous).interrupt(siteId, { cid: event.subject.cid }, event.occurredAt);
      }
      const timeline = JSON.stringify([siteId, 'identity-timeline', event.subject.cid]);
      await this.env.SUBJECTS.getByName(timeline).linkIdentity(envelope);
    } else {
      let home: string;
      if (event.kind === 'exposure' && event.routingKey) {
        const route: unknown = JSON.parse(event.routingKey);
        invariant(Array.isArray(route) && route[0] === siteId, 'invalid_input', 'Exposure route belongs to another site');
        home = event.routingKey;
      } else home = await this.resolveHome(siteId, event.subject, event.occurredAt);
      await this.env.SUBJECTS.getByName(home).ingest(envelope);
    }
  }
  async createExperiment(siteId: string, input: CreateExperiment) {
    id(siteId, 'siteId');
    const result = await this.env.EXPERIMENTS.getByName(experimentKey(siteId, id(input.experimentId, 'experimentId'))).create(input);
    await this.env.SITES.getByName(siteId).registerExperiment(input.experimentId);
    return result;
  }
  async getExperiment(siteId: string, experimentId: string) { return this.experiment(siteId, experimentId).getConfig(); }
  async listExperiments(siteId: string, after = '', limit = 100) { return this.env.SITES.getByName(id(siteId, 'siteId')).listExperiments(after, limit); }
  async updateExperiment(siteId: string, experimentId: string, input: Partial<ExperimentSettings>) { return this.experiment(siteId, experimentId).updateSettings(input); }
  async addArm(siteId: string, experimentId: string, armId: string) { return this.experiment(siteId, experimentId).addArm(armId); }
  async setArmStatus(siteId: string, experimentId: string, armId: string, status: ArmStatus) { return this.experiment(siteId, experimentId).setArmStatus(armId, status); }
  async setExperimentStatus(siteId: string, experimentId: string, status: ArmStatus) { return this.experiment(siteId, experimentId).setStatus(status); }
  async getPolicy(siteId: string, experimentId: string) { return this.experiment(siteId, experimentId).getPolicy(); }
  async createGoal(siteId: string, goalId: string) { return this.env.SITES.getByName(id(siteId, 'siteId')).createGoal(goalId); }
  async getGoal(siteId: string, goalId: string) { return this.env.SITES.getByName(id(siteId, 'siteId')).getGoal(goalId); }
  async listGoals(siteId: string, after = '', limit = 100) { return this.env.SITES.getByName(id(siteId, 'siteId')).listGoals(after, limit); }
  async setGoalStatus(siteId: string, goalId: string, status: GoalStatus) { return this.env.SITES.getByName(id(siteId, 'siteId')).setGoalStatus(goalId, status); }
  async analyticsArmSeries(siteId: string, query: Parameters<AnalyticsAPI['armSeries']>[0]) { return new BasinAnalytics(this.env, siteId).armSeries(query); }
  async analyticsTraffic(siteId: string, query: Parameters<AnalyticsAPI['traffic']>[0]) { return new BasinAnalytics(this.env, siteId).traffic(query); }
  async analyticsPolicies(siteId: string, query: Parameters<AnalyticsAPI['policies']>[0]) { return new BasinAnalytics(this.env, siteId).policies(query); }
  async analyticsAttributeKeys(siteId: string, query: Parameters<AnalyticsAPI['attributeKeys']>[0]) { return new BasinAnalytics(this.env, siteId).attributeKeys(query); }
  async analyticsArms(siteId: string, query: Parameters<AnalyticsAPI['arms']>[0]) { return new BasinAnalytics(this.env, siteId).arms(query); }
  async analyticsTimeline(siteId: string, query: Parameters<AnalyticsAPI['timeline']>[0]) { return new BasinAnalytics(this.env, siteId).timeline(query); }
  async analyticsGoals(siteId: string, query: Parameters<AnalyticsAPI['goals']>[0]) { return new BasinAnalytics(this.env, siteId).goals(query); }
  async analyticsSeries(siteId: string, query: Parameters<AnalyticsAPI['series']>[0]) { return new BasinAnalytics(this.env, siteId).series(query); }
  async analyticsAttributeValues(siteId: string, query: Parameters<AnalyticsAPI['attributeValues']>[0]) { return new BasinAnalytics(this.env, siteId).attributeValues(query); }
  private experiment(siteId: string, experimentId: string) { return this.env.EXPERIMENTS.getByName(experimentKey(id(siteId, 'siteId'), id(experimentId, 'experimentId'))); }
}
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
