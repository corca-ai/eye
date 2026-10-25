import type { SummariesAPI } from '../analytics/summaries.js';
import type { AnalyticsJobsAPI } from '../analytics/jobs.js';
import { compareEvents } from '../core/attribution.js';
import { packIngestion, unpackEvents } from './queue-batch.js';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { RuntimeEnv as Env } from './environment.generated.js';
import { invariant } from '../core/errors.js';
import { parseCreateExperiment, parseEnvelope } from '../core/events.js';
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
  override fetch(): Response { return new Response('Not found', { status: 404 }); }
  async getPublishedPolicy(siteId: string, experimentId: string, maxAgeMs?: number): Promise<PublishedPolicy> { return this.site(siteId).publishedPolicy(siteId, id(experimentId, 'experimentId'), maxAgeMs); }
  async ingest(inputs: readonly EventEnvelope[]): Promise<void> {
    invariant(Array.isArray(inputs) && inputs.length <= 100, 'invalid_input', 'An ingestion batch must contain at most 100 events');
    const envelopes = inputs.map(input => parseEnvelope(input, Date.now()));
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
        try { const envelope = parseEnvelope(input, Date.now()); validateRawEnvelope(envelope); work.push({ message, envelope }); }
        catch (error) {
          const code = errorCode(error);
          console.warn(JSON.stringify({ component: 'eye', operation: 'consume', code: code ?? 'unavailable', messageId: message.id }));
          if (code !== 'invalid_input' && code !== 'outside_retention' && code !== 'conflict') retries.add(message);
        }
      }
    }
    const statuses = new Map<EventEnvelope, boolean>();
    for (const siteId of new Set(work.filter(w => w.envelope.event.kind !== 'track').map(w => w.envelope.siteId))) {
      const group = work.filter(w => w.envelope.siteId === siteId && w.envelope.event.kind !== 'track')
        .sort((a, b) => compareEvents(a.envelope.event, b.envelope.event));
      for (let offset = 0; offset < group.length; offset += 100) {
        const chunk = group.slice(offset, offset + 100);
        try {
          const accepted = await this.env.SITES.getByName(siteId).consumeLearning(siteId, chunk.map(w => w.envelope.event));
          chunk.forEach((item, i) => statuses.set(item.envelope, accepted[i] === true));
        } catch { for (const item of chunk) retries.add(item.message); }
      }
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
    try { await sendExportBatches(items.flatMap(item => item.records.map(record => ({ record }))), group => this.env.ANALYTICS.send(group)); }
    catch (error) { for (const item of items) item.message.retry(); throw error; }
    for (const message of batch.messages) { if (retries.has(message)) message.retry(); else message.ack(); }
  }
  async createExperiment(siteId: string, input: CreateExperiment): Promise<Experiment> {
    return this.site(siteId).createExperiment(siteId, parseCreateExperiment(input));
  }
  async getExperiment(siteId: string, experimentId: string): Promise<Experiment> { return this.site(siteId).getExperiment(siteId, id(experimentId, 'experimentId')); }
  async listExperiments(siteId: string, after = '', limit = 100) { return this.site(siteId).listExperiments(after, limit); }
  async updateExperiment(siteId: string, experimentId: string, input: Partial<ExperimentSettings>): Promise<Experiment> {
    return this.site(siteId).updateExperiment(siteId, id(experimentId, 'experimentId'), input);
  }
  async addArm(siteId: string, experimentId: string, armId: string): Promise<Experiment> { return this.site(siteId).addExperimentArm(siteId, id(experimentId, 'experimentId'), id(armId, 'armId')); }
  async setArmStatus(siteId: string, experimentId: string, armId: string, status: ArmStatus): Promise<Experiment> { return this.site(siteId).setExperimentArmStatus(siteId, id(experimentId, 'experimentId'), id(armId, 'armId'), status); }
  async setExperimentStatus(siteId: string, experimentId: string, status: ArmStatus): Promise<Experiment> { return this.site(siteId).setExperimentStatus(siteId, id(experimentId, 'experimentId'), status); }
  async getPolicy(siteId: string, experimentId: string): Promise<PolicySnapshot> { return this.site(siteId).getExperimentPolicy(siteId, id(experimentId, 'experimentId')); }
  async createGoal(siteId: string, goalId: string) { return this.env.SITES.getByName(id(siteId, 'siteId')).createGoal(goalId); }
  async getGoal(siteId: string, goalId: string) { return this.env.SITES.getByName(id(siteId, 'siteId')).getGoal(goalId); }
  async listGoals(siteId: string, after = '', limit = 100) { return this.env.SITES.getByName(id(siteId, 'siteId')).listGoals(after, limit); }
  async setGoalStatus(siteId: string, goalId: string, status: GoalStatus) { return this.env.SITES.getByName(id(siteId, 'siteId')).setGoalStatus(goalId, status); }
  async configureSummaries(siteId: string, input: Parameters<SummariesAPI['configure']>[0]) { return this.env.SITES.getByName(id(siteId, 'siteId')).configureSummaries(siteId, input); }
  async summaryStatus(siteId: string) { return this.env.SITES.getByName(id(siteId, 'siteId')).summaryStatus(); }
  async querySummary(siteId: string, input: Parameters<SummariesAPI['query']>[0]) { return this.env.SITES.getByName(id(siteId, 'siteId')).querySummary(input); }
  async analyticsJobSchedule(siteId: string, input: Parameters<AnalyticsJobsAPI['schedule']>[0]) { id(siteId, 'siteId'); return this.env.REPORTS.getByName(siteId).schedule(siteId, input); }
  async analyticsJobScheduled(siteId: string, input: Parameters<AnalyticsJobsAPI['scheduled']>[0]) { id(siteId, 'siteId'); return this.env.REPORTS.getByName(siteId).getSchedule(input); }
  async analyticsJobUnschedule(siteId: string, input: Parameters<AnalyticsJobsAPI['unschedule']>[0]) { id(siteId, 'siteId'); return this.env.REPORTS.getByName(siteId).unschedule(input); }
  async analyticsJobCreate(siteId: string, input: Parameters<AnalyticsJobsAPI['create']>[0]) { id(siteId, 'siteId'); return this.env.REPORTS.getByName(siteId).create(siteId, input); }
  async analyticsJobStatus(siteId: string, input: Parameters<AnalyticsJobsAPI['status']>[0]) { id(siteId, 'siteId'); return this.env.REPORTS.getByName(siteId).status(input); }
  async analyticsJobPage(siteId: string, input: Parameters<AnalyticsJobsAPI['page']>[0]) { id(siteId, 'siteId'); return this.env.REPORTS.getByName(siteId).page(input); }
  async analyticsJobCancel(siteId: string, input: Parameters<AnalyticsJobsAPI['cancel']>[0]) { id(siteId, 'siteId'); return this.env.REPORTS.getByName(siteId).cancel(input); }
  async analyticsArmSeries(siteId: string, query: Parameters<AnalyticsAPI['armSeries']>[0]) { return new BasinAnalytics(this.env, siteId).armSeries(query); }
  async analyticsTraffic(siteId: string, query: Parameters<AnalyticsAPI['traffic']>[0]) { return new BasinAnalytics(this.env, siteId).traffic(query); }
  async analyticsPolicies(siteId: string, query: Parameters<AnalyticsAPI['policies']>[0]) { return new BasinAnalytics(this.env, siteId).policies(query); }
  async analyticsAttributeKeys(siteId: string, query: Parameters<AnalyticsAPI['attributeKeys']>[0]) { return new BasinAnalytics(this.env, siteId).attributeKeys(query); }
  async analyticsLearning(siteId: string, query: Parameters<AnalyticsAPI['learning']>[0]) { return new BasinAnalytics(this.env, siteId).learning(query); }
  async analyticsArms(siteId: string, query: Parameters<AnalyticsAPI['arms']>[0]) { return new BasinAnalytics(this.env, siteId).arms(query); }
  async analyticsTimeline(siteId: string, query: Parameters<AnalyticsAPI['timeline']>[0]) { return new BasinAnalytics(this.env, siteId).timeline(query); }
  async analyticsGoals(siteId: string, query: Parameters<AnalyticsAPI['goals']>[0]) { return new BasinAnalytics(this.env, siteId).goals(query); }
  async analyticsSeries(siteId: string, query: Parameters<AnalyticsAPI['series']>[0]) { return new BasinAnalytics(this.env, siteId).series(query); }
  async analyticsAttributeValues(siteId: string, query: Parameters<AnalyticsAPI['attributeValues']>[0]) { return new BasinAnalytics(this.env, siteId).attributeValues(query); }
  private site(siteId: string) { return this.env.SITES.getByName(id(siteId, 'siteId')); }
}
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
