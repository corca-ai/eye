import { EyeError, invariant } from './core/errors.js';
import type { ErrorCode } from './core/errors.js';
import { parseCreateExperiment, parseEnvelope } from './core/events.js';
import { id, subject as parseSubject } from './core/validation.js';
import type { Attributes, CreateExperiment, EventEnvelope, ExperimentSettings, GoalEvent, IdentityEvent, Subject, TrackEvent } from './core/types.js';
import type { AssignedDecision, EyeService } from './transport.js';
import type { AnalyticsAPI } from './analytics/types.js';

export const MAX_EVENT_BYTES = 100_000;
export const MAX_BATCH_BYTES = 240_000;
const encoder = new TextEncoder();
export type EventInput<T> = Omit<T, 'kind' | 'eventId' | 'occurredAt'> & { eventId?: string; occurredAt?: number };
export type Submission = { accepted: true; eventId: string } | { accepted: false; error: { code: ErrorCode; message: string } };
export interface EyeOptions {
  service: EyeService;
  ctx: Pick<ExecutionContext, 'waitUntil'>;
  siteId: string;
  /** Reports background delivery failures. Exceptions from this hook never fail host requests. */
  onError?: (error: unknown) => void;
}
export function encodedSize(value: unknown): number { return encoder.encode(JSON.stringify(value)).byteLength; }

export function createEye(options: EyeOptions) {
  const siteId = id(options.siteId, 'siteId'), service = options.service;
  let pending: { envelope: EventEnvelope; bytes: number }[] = [];
  let delivery: Promise<void> | null = null;
  const report = (error: unknown) => {
    try { options.onError?.(error); } catch { /* The host's error hook cannot break event delivery. */ }
  };
  const flush = (): Promise<void> => {
    if (delivery) return delivery;
    if (pending.length === 0) return Promise.resolve();
    delivery = Promise.resolve().then(async () => {
      let failed = false;
      let failure: unknown;
      while (pending.length > 0) {
        const queued = pending;
        pending = [];
        let cursor = 0;
        while (cursor < queued.length) {
          const batch: EventEnvelope[] = [];
          let bytes = 0;
          while (queued[cursor] && batch.length < 100 && bytes + queued[cursor]!.bytes <= MAX_BATCH_BYTES) {
            const next = queued[cursor++]!; batch.push(next.envelope); bytes += next.bytes;
          }
          try { await service.ingest(batch); } catch (error) { failed = true; failure = error; }
        }
      }
      if (failed) throw failure;
    }).finally(() => { delivery = null; if (pending.length > 0) void flush(); });
    // Attach the rejection handler immediately, even when the caller never awaits flush().
    options.ctx.waitUntil(delivery.catch(report));
    return delivery;
  };
  const submit = (build: () => object): Submission => {
    try {
      const event = build();
      const receivedAt = Date.now();
      const envelope = parseEnvelope({ siteId, receivedAt, event }, receivedAt);
      const bytes = encodedSize(envelope) + 200;
      invariant(bytes <= MAX_EVENT_BYTES, 'invalid_input', 'Event exceeds the 100 KB encoded envelope limit');
      pending.push({ envelope, bytes });
      void flush();
      return { accepted: true, eventId: envelope.event.eventId };
    } catch (error) {
      return { accepted: false, error: { code: error instanceof EyeError ? error.code : 'invalid_input', message: error instanceof Error ? error.message : 'Invalid event' } };
    }
  };
  const base = <T extends { eventId?: string; occurredAt?: number }>(input: T) => ({ ...input, eventId: input.eventId ?? crypto.randomUUID(), occurredAt: input.occurredAt ?? Date.now() });
  return {
    /** accepted means local validation passed; it is not a durable delivery acknowledgement. */
    track: (input: EventInput<TrackEvent>): Submission => submit(() => ({ ...base(input), kind: 'track' })),
    goal: (input: EventInput<GoalEvent>): Submission => submit(() => ({ ...base(input), kind: 'goal' })),
    expose: (input: { subject: Subject; decision: AssignedDecision; eventId?: string; occurredAt?: number; userAttributes?: Attributes; attributes?: Attributes }): Submission => submit(() => {
      const { decision, ...rest } = input;
      return { ...base(rest), kind: 'exposure', assignment: decision.assignment, ...(decision.routingKey === undefined ? {} : { routingKey: decision.routingKey }) };
    }),
    identify: (input: EventInput<IdentityEvent> & { subject: Subject & { uid: string } }): Submission => submit(() => ({ ...base(input), kind: 'identify' })),
    logout: (input: EventInput<IdentityEvent>): Submission => submit(() => ({ ...base(input), kind: 'logout' })),
    decide: (input: { subject: Subject; experimentId: string }) => service.decide(siteId, parseSubject(input.subject), id(input.experimentId, 'experimentId')),
    /** Optional for jobs/tests that need to await Queue ingestion. Normal request handlers need not await this. */
    flush,
    analytics: {
      arms: query => service.analyticsArms(siteId, query),
      timeline: query => service.analyticsTimeline(siteId, query),
      goals: query => service.analyticsGoals(siteId, query),
      series: query => service.analyticsSeries(siteId, query),
      attributeValues: query => service.analyticsAttributeValues(siteId, query),
    } satisfies AnalyticsAPI,
    experiments: {
      create: (input: CreateExperiment) => service.createExperiment(siteId, parseCreateExperiment(input)),
      get: (experimentId: string) => service.getExperiment(siteId, id(experimentId, 'experimentId')),
      list: (options: { after?: string; limit?: number } = {}) => service.listExperiments(siteId, options.after, options.limit),
      update: (experimentId: string, input: Partial<ExperimentSettings>) => service.updateExperiment(siteId, id(experimentId, 'experimentId'), input),
      addArm: (experimentId: string, armId: string) => service.addArm(siteId, id(experimentId, 'experimentId'), id(armId, 'armId')),
      pauseArm: (experimentId: string, armId: string) => service.setArmStatus(siteId, id(experimentId, 'experimentId'), id(armId, 'armId'), 'paused'),
      resumeArm: (experimentId: string, armId: string) => service.setArmStatus(siteId, id(experimentId, 'experimentId'), id(armId, 'armId'), 'active'),
      policy: (experimentId: string) => service.getPolicy(siteId, id(experimentId, 'experimentId')),
    },
    goals: {
      create: (goalId: string) => service.createGoal(siteId, id(goalId, 'goalId')),
      get: (goalId: string) => service.getGoal(siteId, id(goalId, 'goalId')),
      list: (options: { after?: string; limit?: number } = {}) => service.listGoals(siteId, options.after, options.limit),
      pause: (goalId: string) => service.setGoalStatus(siteId, id(goalId, 'goalId'), 'paused'),
      resume: (goalId: string) => service.setGoalStatus(siteId, id(goalId, 'goalId'), 'active'),
      delete: (goalId: string) => service.setGoalStatus(siteId, id(goalId, 'goalId'), 'deleted'),
    },
  };
}
export type EyeClient = ReturnType<typeof createEye>;
