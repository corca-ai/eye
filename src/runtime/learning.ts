import { BasinAnalytics, type AnalyticsEnv } from '../analytics/query.js';
import { analyticsRecord, type AnalyticsRecord } from '../analytics/records.js';
import { closingSQL } from './learning-sql.js';
import { reduceClosedCohort, closedSampleMoments, type CohortInput, type ClosedCohort, type SampleExposure } from '../core/closed-cohort.js';
import { parseEvent } from '../core/events.js';
import { finite, invariant } from '../core/errors.js';
import { RETENTION_MS, subjectKey } from '../core/validation.js';
import type { EyeEvent } from '../core/types.js';

export const COHORT_INTERVAL_MS = 3_600_000;
export const COHORT_PAGE_SIZE = 1000;
export interface LearningPage { cohort: ClosedCohort; records: AnalyticsRecord[]; next: string | null }
/** Storage computes one closing interval. Large result sets use bounded sample
 * partitions; zero rewards and other experiments in the denominator are preserved.
 */
export class LearningSource {
  private sql?: BasinAnalytics;
  private readonly table: string;
  constructor(private readonly env: AnalyticsEnv, private readonly siteId: string, private readonly bounds = { windowMs: RETENTION_MS, graceMs: 0, attributionMs: RETENTION_MS }, private readonly request: typeof fetch = fetch.bind(globalThis), private readonly clock: () => number = Date.now) {
    const namespace = env.EYE_ANALYTICS_NAMESPACE ?? 'eye';
    invariant(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(namespace), 'invalid_input', 'Invalid namespace');
    this.table = namespace;
  }
  async page(from: number, until: number, after: string, limit = COHORT_PAGE_SIZE): Promise<LearningPage> {
    const sql = this.sql ??= new BasinAnalytics(this.env, this.siteId, this.request, this.clock);
    const visibleAt = this.clock(), cohortId = JSON.stringify([this.siteId, from, until, after]);
    const rows = await sql.learningQuery(closingSQL(this.table, this.siteId, from, until, after, limit, visibleAt, this.bounds), limit);
    const exposures = rows.map(row => {
      invariant(row.context_conflict === 0, 'conflict', 'Conflicting sample context');
      invariant(typeof row.payload_json === 'string' && typeof row.observation_id === 'string', 'unavailable', 'Invalid closing sample');
      const event = parseEvent(JSON.parse(row.payload_json));
      invariant(event.kind === 'exposure' && event.sample?.sampleId === row.observation_id && event.attributionWindowMs,
        'unavailable', 'Invalid closing exposure');
      return { event, sampleId: event.sample.sampleId, startAt: event.sample.startAt, attributionWindowMs: event.attributionWindowMs };
    });
    const validation = reduceClosedCohort({ cohortId, from, until, asOf: until, exposures, goals: [], identities: [] });
    invariant(validation.samples.length === rows.length, 'unavailable', 'Closing sample outside requested interval');
    const samples = validation.samples.map((sample, i) => {
      const reward = rows[i]!.reward;
      invariant(typeof reward === 'number', 'unavailable', 'Invalid closing reward');
      return { ...sample, reward: finite(reward, 'Closing reward') };
    });
    const cohort = { cohortId, asOf: until, samples, arms: closedSampleMoments(samples, until) };
    // Per-goal raw attribution remains an analytics query. Learning exports its
    // fixed per-observation outcome, avoiding another copy of every goal credit.
    return learningPage(this.siteId, cohort, exposures, rows.length < limit ? null : String(rows.at(-1)!.observation_id), visibleAt);
  }
}

export function reduceLearningPage(siteId: string, cohortId: string, from: number, until: number, sampleIds: string[], events: readonly EyeEvent[], next: string | null, receivedAt: number): LearningPage {
  const input: CohortInput = { cohortId, from, until, asOf: until, sampleIds,
    exposures: events.filter(e => e.kind === 'exposure' && e.sample && e.attributionWindowMs).map(event => {
      invariant(event.kind === 'exposure' && event.sample && event.attributionWindowMs, 'invalid_input', 'Missing sample');
      return { event, sampleId: event.sample.sampleId, startAt: event.sample.startAt, attributionWindowMs: event.attributionWindowMs };
    }), goals: events.filter(e => e.kind === 'goal'), identities: events.filter((e): e is import('../core/types.js').IdentityEvent => e.kind === 'identify' || e.kind === 'logout') };
  return learningPage(siteId, reduceClosedCohort(input), input.exposures, next, receivedAt);
}

function learningPage(siteId: string, cohort: ClosedCohort, exposures: readonly SampleExposure[], next: string | null, receivedAt: number): LearningPage {
  const records: AnalyticsRecord[] = [];
  const firstBySample = new Map<string, SampleExposure>();
  for (const exposure of exposures) if (!firstBySample.has(exposure.sampleId)) firstBySample.set(exposure.sampleId, exposure);
  for (const sample of cohort.samples) {
    const first = firstBySample.get(sample.sampleId)!;
    const context = { siteId, subjectKey: subjectKey(siteId, first.event.subject), ...first.event.subject };
    records.push(analyticsRecord(context, 'observations', sample.sampleId, 2, sample.startAt, receivedAt,
      { ...sample, observationId: sample.sampleId, assignmentId: sample.assignment.assignmentId,
        experimentId: sample.assignment.experimentId, armId: sample.assignment.armId, generation: sample.assignment.generation,
        closeAt: sample.endAt + sample.assignment.settings.allowedLatenessMs, status: 'complete', learningClosed: true },
      { experiment_id: sample.assignment.experimentId, arm_id: sample.assignment.armId, assignment_id: sample.assignment.assignmentId,
        observation_id: sample.sampleId, status: 'complete', value: sample.reward }, first.event.userAttributes));
  }
  for (const credit of cohort.credits ?? []) {
    const exposure = exposures.find(e => e.event.eventId === credit.exposureId)!;
    records.push(analyticsRecord({ siteId, subjectKey: subjectKey(siteId, exposure.event.subject), ...exposure.event.subject },
      'credits', JSON.stringify([credit.goalEventId, credit.experimentId]), 1, credit.occurredAt, receivedAt, credit,
      { experiment_id: credit.experimentId, arm_id: credit.armId, assignment_id: credit.assignmentId,
        observation_id: credit.observationId, goal_id: credit.goalId, status: 'eligible', value: credit.value }));
  }
  return { cohort, records, next };
}
