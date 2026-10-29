import type { SummariesAPI } from '../analytics/summaries.js';
import type { AnalyticsJobsAPI } from '../analytics/jobs.js';
import { compareEvents } from '../core/attribution.js';
import { packIngestion, unpackEvents } from './queue-batch.js';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { RuntimeEnv as Env } from './environment.generated.js';
import { invariant } from '../core/errors.js';
import { parseCreateExperiment, parseEnvelope, validateEventAge } from '../core/events.js';
import { id } from '../core/validation.js';
import type { ArmStatus, CreateExperiment, EventEnvelope, Experiment, ExperimentSettings, GoalStatus } from '../core/types.js';
import type { EyeService, PublishedPolicy, PolicySnapshot } from '../transport.js';
import { rawRecords, validateRawEnvelope } from '../analytics/raw.js';
import { type AnalyticsRecord } from '../analytics/records.js';
import { sendExportBatches } from '../analytics/export.js';
import { BasinAnalytics } from '../analytics/query.js';
import type { AnalyticsEnv } from '../analytics/query.js';
import type { AnalyticsAPI } from '../analytics/types.js';

export class EyeWorker extends WorkerEntrypoint<Env & AnalyticsEnv> implements EyeService {
  private get installationId(): string {
    const value = id(this.env.EYE_INSTALLATION_ID, 'installationId');
    invariant(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value), 'invalid_input', 'EYE_INSTALLATION_ID must be a UUID');
    return value;
  }
  async getInstallationId(): Promise<string> { return this.installationId; }
  override fetch(): Response { return new Response('Not found', { status: 404 }); }
  async getPublishedPolicy(experimentId: string, maxAgeMs?: number): Promise<PublishedPolicy> { return this.site().publishedPolicy(this.installationId, id(experimentId, 'experimentId'), maxAgeMs); }
  async ingest(inputs: readonly Omit<EventEnvelope, 'siteId'>[]): Promise<void> {
    invariant(Array.isArray(inputs) && inputs.length <= 100, 'invalid_input', 'An ingestion batch must contain at most 100 events');
    const receivedAt = Date.now();
    const envelopes = inputs.map(input => {
      const envelope = parseEnvelope({ ...input, receivedAt, siteId: this.installationId }, receivedAt);
      validateEventAge(envelope.event, receivedAt);
      return envelope;
    });
    const batches = packIngestion(envelopes);
    if (batches.length > 0) await this.env.EVENTS.sendBatch(batches.map(body => ({ body, contentType: 'json' })));
  }
  override async queue(batch: MessageBatch<unknown>): Promise<void> {
    const work: { message: Message<unknown>; envelope: EventEnvelope }[] = [];
    const retries = new Set<Message<unknown>>();
    for (const message of batch.messages) {
      let inputs: unknown[];
      try { inputs = unpackEvents(message.body); }
      catch { message.ack(); continue; }
      for (const input of inputs) {
        try { const envelope = parseEnvelope(input, Date.now()); validateRawEnvelope(envelope); invariant(envelope.siteId === this.installationId, 'invalid_input', 'Queue installation mismatch'); work.push({ message, envelope }); }
        catch (error) {
          const code = errorCode(error);
          console.warn(JSON.stringify({ component: 'eye', operation: 'consume', code: code ?? 'unavailable', messageId: message.id }));
          if (code !== 'invalid_input' && code !== 'outside_retention' && code !== 'conflict') retries.add(message);
        }
      }
    }
    const statuses = new Map<EventEnvelope, boolean>();
    const group = work.filter(w => w.envelope.event.kind !== 'track')
      .sort((a, b) => compareEvents(a.envelope.event, b.envelope.event));
    for (let offset = 0; offset < group.length; offset += 100) {
      const chunk = group.slice(offset, offset + 100);
      try {
        const accepted = await this.site().consumeLearning(this.installationId, chunk.map(w => w.envelope.event), chunk.map(w => w.envelope.receivedAt));
        chunk.forEach((item, i) => statuses.set(item.envelope, accepted[i] === true));
      } catch { for (const item of chunk) retries.add(item.message); }
    }
    const items: { message: Message<unknown>; records: AnalyticsRecord[] }[] = [];
    for (const { message, envelope } of work) {
      if (envelope.event.kind !== 'track' && !statuses.has(envelope)) continue;
      const accepted = envelope.event.kind === 'track' || statuses.get(envelope) === true;
      // A conflicting exposure cannot feed raw-derived observations either.
      if (envelope.event.kind === 'exposure' && !accepted) continue;
      items.push({ message, records: rawRecords(envelope, accepted) });
    }
    // Retry-safe learning is separate from lazy, bounded raw projection delivery.
    const remaining = new Map<Message<unknown>, number>();
    const acknowledged = new Set<Message<unknown>>();
    const rows = items.flatMap(({ message, records }) => {
      remaining.set(message, (remaining.get(message) ?? 0) + records.length);
      return records.map(record => ({ record, message }));
    });
    try {
      await sendExportBatches(rows, group => this.env.ANALYTICS.send(group), undefined, completed => {
        for (const { message } of completed) {
          const count = remaining.get(message)! - 1;
          remaining.set(message, count);
          if (count === 0 && !retries.has(message)) { message.ack(); acknowledged.add(message); }
        }
      });
    } catch (error) {
      for (const message of batch.messages) if (!acknowledged.has(message)) message.retry();
      throw error;
    }
    for (const message of batch.messages) {
      if (acknowledged.has(message)) continue;
      if (retries.has(message)) message.retry(); else message.ack();
    }
  }
  async createExperiment(input: CreateExperiment): Promise<Experiment> {
    return this.site().createExperiment(this.installationId, parseCreateExperiment(input));
  }
  async getExperiment(experimentId: string): Promise<Experiment> { return this.site().getExperiment(this.installationId, id(experimentId, 'experimentId')); }
  async listExperiments(after = '', limit = 100) { return this.site().listExperiments(after, limit); }
  async updateExperiment(experimentId: string, input: Partial<ExperimentSettings>): Promise<Experiment> {
    return this.site().updateExperiment(this.installationId, id(experimentId, 'experimentId'), input);
  }
  async addArm(experimentId: string, armId: string): Promise<Experiment> { return this.site().addExperimentArm(this.installationId, id(experimentId, 'experimentId'), id(armId, 'armId')); }
  async setArmStatus(experimentId: string, armId: string, status: ArmStatus): Promise<Experiment> { return this.site().setExperimentArmStatus(this.installationId, id(experimentId, 'experimentId'), id(armId, 'armId'), status); }
  async setExperimentStatus(experimentId: string, status: ArmStatus): Promise<Experiment> { return this.site().setExperimentStatus(this.installationId, id(experimentId, 'experimentId'), status); }
  async getPolicy(experimentId: string): Promise<PolicySnapshot> { return this.site().getExperimentPolicy(this.installationId, id(experimentId, 'experimentId')); }
  async createGoal(goalId: string) { return this.env.SITES.getByName(this.installationId).createGoal(goalId); }
  async getGoal(goalId: string) { return this.env.SITES.getByName(this.installationId).getGoal(goalId); }
  async listGoals(after = '', limit = 100) { return this.env.SITES.getByName(this.installationId).listGoals(after, limit); }
  async setGoalStatus(goalId: string, status: GoalStatus) { return this.env.SITES.getByName(this.installationId).setGoalStatus(goalId, status); }
  async hourlyGoalStatus() { return this.site().hourlyGoalStatus(); }
  async hourlyGoals(input: Parameters<SummariesAPI['series']>[0]) { return this.site().hourlyGoals(input); }
  async configureSummaries(input: Parameters<SummariesAPI['configure']>[0]) { return this.env.SITES.getByName(this.installationId).configureSummaries(this.installationId, input); }
  async summaryStatus() { return this.env.SITES.getByName(this.installationId).summaryStatus(); }
  async querySummary(input: Parameters<SummariesAPI['query']>[0]) { return this.env.SITES.getByName(this.installationId).querySummary(input); }
  async analyticsJobSchedule(input: Parameters<AnalyticsJobsAPI['schedule']>[0]) { this.installationId; return this.env.REPORTS.getByName(this.installationId).schedule(this.installationId, input); }
  async analyticsJobScheduled(input: Parameters<AnalyticsJobsAPI['scheduled']>[0]) { this.installationId; return this.env.REPORTS.getByName(this.installationId).getSchedule(input); }
  async analyticsJobUnschedule(input: Parameters<AnalyticsJobsAPI['unschedule']>[0]) { this.installationId; return this.env.REPORTS.getByName(this.installationId).unschedule(input); }
  async analyticsJobCreate(input: Parameters<AnalyticsJobsAPI['create']>[0]) { this.installationId; return this.env.REPORTS.getByName(this.installationId).create(this.installationId, input); }
  async analyticsJobStatus(input: Parameters<AnalyticsJobsAPI['status']>[0]) { this.installationId; return this.env.REPORTS.getByName(this.installationId).status(input); }
  async analyticsJobPage(input: Parameters<AnalyticsJobsAPI['page']>[0]) { this.installationId; return this.env.REPORTS.getByName(this.installationId).page(input); }
  async analyticsJobCancel(input: Parameters<AnalyticsJobsAPI['cancel']>[0]) { this.installationId; return this.env.REPORTS.getByName(this.installationId).cancel(input); }
  async analyticsArmSeries(query: Parameters<AnalyticsAPI['armSeries']>[0]) { return new BasinAnalytics(this.env, this.installationId).armSeries(query); }
  async analyticsTraffic(query: Parameters<AnalyticsAPI['traffic']>[0]) { return new BasinAnalytics(this.env, this.installationId).traffic(query); }
  async analyticsPolicies(query: Parameters<AnalyticsAPI['policies']>[0]) { return new BasinAnalytics(this.env, this.installationId).policies(query); }
  async analyticsAttributeKeys(query: Parameters<AnalyticsAPI['attributeKeys']>[0]) { return new BasinAnalytics(this.env, this.installationId).attributeKeys(query); }
  async analyticsLearning(query: Parameters<AnalyticsAPI['learning']>[0]) { return new BasinAnalytics(this.env, this.installationId).learning(query); }
  async analyticsArms(query: Parameters<AnalyticsAPI['arms']>[0]) { return new BasinAnalytics(this.env, this.installationId).arms(query); }
  async analyticsTimeline(query: Parameters<AnalyticsAPI['timeline']>[0]) { return new BasinAnalytics(this.env, this.installationId).timeline(query); }
  async analyticsEventList(query: Parameters<AnalyticsAPI['eventList']>[0]) { return new BasinAnalytics(this.env, this.installationId).eventList(query); }
  async analyticsEvents(query: Parameters<AnalyticsAPI['events']>[0]) { return new BasinAnalytics(this.env, this.installationId).events(query); }
  async analyticsGoals(query: Parameters<AnalyticsAPI['goals']>[0]) { return new BasinAnalytics(this.env, this.installationId).goals(query); }
  async analyticsSeries(query: Parameters<AnalyticsAPI['series']>[0]) { return new BasinAnalytics(this.env, this.installationId).series(query); }
  async analyticsAttributeValues(query: Parameters<AnalyticsAPI['attributeValues']>[0]) { return new BasinAnalytics(this.env, this.installationId).attributeValues(query); }
  private site() { return this.env.SITES.getByName(this.installationId); }
}
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
