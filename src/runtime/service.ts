import type { ArmInput } from '../core/types.js';
import type { SummariesAPI } from '../analytics/summaries.js';
import { compareEvents } from '../core/attribution.js';
import { packIngestion, unpackEvents } from './queue-batch.js';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { RuntimeEnv as Env } from './environment.generated.js';
import { invariant } from '../core/errors.js';
import { hasExposureContext } from '../core/sample-context.js';
import { parseCreateExperiment, parseEnvelope, validateEventAge } from '../core/events.js';
import { id } from '../core/validation.js';
import type { ArmStatus, CreateExperiment, EventEnvelope, Experiment, ExperimentSettings, GoalStatus } from '../core/types.js';
import type { EyeService, PublishedPolicy, PolicySnapshot } from '../transport.js';

export class EyeWorker extends WorkerEntrypoint<Env> implements EyeService {
  private get installationId(): string {
    const value = id(this.env.EYE_INSTALLATION_ID, 'installationId');
    invariant(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value), 'invalid_input', 'EYE_INSTALLATION_ID must be a UUID');
    return value;
  }
  async getInstallationId(): Promise<string> { return this.installationId; }
  override fetch(): Response { return new Response('Not found', { status: 404 }); }
  async getPublishedPolicy(experimentId: string, maxAgeMs?: number): Promise<PublishedPolicy | null> { return this.site().publishedPolicy(this.installationId, id(experimentId, 'experimentId'), maxAgeMs); }
  async ingest(inputs: readonly Omit<EventEnvelope, 'siteId'>[]): Promise<void> {
    invariant(Array.isArray(inputs) && inputs.length <= 100, 'invalid_input', 'An ingestion batch must contain at most 100 events');
    const receivedAt = Date.now();
    const envelopes = inputs.filter(input => !retiredEvent(input)).map(input => {
      const envelope = parseEnvelope({ ...input, receivedAt, siteId: this.installationId }, receivedAt);
      validateEventAge(envelope.event, receivedAt);
      return envelope;
    });
    const batches = packIngestion(envelopes, learningEnvelope);
    if (batches.length > 0) await this.env.EVENTS.sendBatch(batches.map(body => ({ body, contentType: 'json' })));
  }
  override async queue(batch: MessageBatch<unknown>): Promise<void> {
    const work: { message: Message<unknown>; envelope: EventEnvelope }[] = [];
    const retries = new Set<Message<unknown>>();
    const siteId = this.installationId;
    for (const message of batch.messages) {
      let inputs: unknown[];
      try { inputs = unpackEvents(message.body); }
      catch { continue; }
      for (const input of inputs) {
        if (retiredEvent(input)) continue;
        try {
          const envelope = parseEnvelope(input, Date.now());
          invariant(envelope.siteId === siteId, 'invalid_input', 'Queue installation mismatch');
          work.push({ message, envelope: learningEnvelope(envelope) });
        } catch (error) {
          const code = errorCode(error);
          console.warn(JSON.stringify({ component: 'eye', operation: 'consume', code: code ?? 'unavailable', messageId: message.id }));
          if (code !== 'invalid_input' && code !== 'outside_retention' && code !== 'conflict') retries.add(message);
        }
      }
    }
    if (work.length) {
      work.sort((a, b) => compareEvents(a.envelope.event, b.envelope.event));
      let site: ReturnType<EyeWorker['site']> | undefined;
      for (let offset = 0; offset < work.length; offset += 100) {
        const chunk = work.slice(offset, offset + 100);
        try {
          await (site ??= this.site()).consumeLearning(siteId, chunk.map(w => w.envelope.event), chunk.map(w => w.envelope.receivedAt));
        } catch { for (const item of chunk) retries.add(item.message); }
      }
    }
    for (const message of batch.messages) {
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
  async addArm(experimentId: string, armId: ArmInput): Promise<Experiment> { return this.site().addExperimentArm(this.installationId, id(experimentId, 'experimentId'), armId); }
  async setArmStatus(experimentId: string, armId: string, status: ArmStatus): Promise<Experiment> { return this.site().setExperimentArmStatus(this.installationId, id(experimentId, 'experimentId'), id(armId, 'armId'), status); }
  async setExperimentStatus(experimentId: string, status: ArmStatus): Promise<Experiment> { return this.site().setExperimentStatus(this.installationId, id(experimentId, 'experimentId'), status); }
  async getPolicy(experimentId: string): Promise<PolicySnapshot> { return this.site().getExperimentPolicy(this.installationId, id(experimentId, 'experimentId')); }
  async createGoal(goalId: string) { return this.env.SITES.getByName(this.installationId).createGoal(goalId); }
  async getGoal(goalId: string) { return this.env.SITES.getByName(this.installationId).getGoal(goalId); }
  async listGoals(after = '', limit = 100) { return this.env.SITES.getByName(this.installationId).listGoals(after, limit); }
  async setGoalStatus(goalId: string, status: GoalStatus) { return this.env.SITES.getByName(this.installationId).setGoalStatus(goalId, status); }
  async experimentDashboard(input: Parameters<SummariesAPI['dashboard']>[0]) { return this.site().experimentDashboard(input); }
  async hourlyGoalStatus() { return this.site().hourlyGoalStatus(); }
  async hourlyGoals(input: Parameters<SummariesAPI['series']>[0]) { return this.site().hourlyGoals(input); }
  async configureSummaries(input: Parameters<SummariesAPI['configure']>[0]) { return this.env.SITES.getByName(this.installationId).configureSummaries(this.installationId, input); }
  async summaryStatus() { return this.env.SITES.getByName(this.installationId).summaryStatus(); }
  async querySummary(input: Parameters<SummariesAPI['query']>[0]) { return this.env.SITES.getByName(this.installationId).querySummary(input); }
  private site() { return this.env.SITES.getByName(this.installationId); }
}
function learningEnvelope(envelope: EventEnvelope): EventEnvelope {
  const { event } = envelope;
  if (event.kind === 'exposure') {
    invariant(hasExposureContext(event), 'invalid_input', 'Exposure requires sample and attribution context');
    if (event.attributes === undefined && event.userAttributes === undefined) return envelope;
    const { attributes: _attributes, userAttributes: _userAttributes, ...exposure } = event;
    return { ...envelope, event: exposure };
  }
  if (event.attributes === undefined) return envelope;
  const { attributes: _attributes, ...learning } = event;
  return { ...envelope, event: learning };
}
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

// Ignore obsolete page events from an older host or already queued batches.
function retiredEvent(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || !('event' in input)) return false;
  const event = input.event;
  return typeof event === 'object' && event !== null && 'kind' in event && event.kind === 'track';
}
