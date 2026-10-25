import { compareEvents } from './attribution.js';
import { finite, invariant } from './errors.js';
import { IdentityHistory } from './identity-history.js';
import { addSample, decayFactor, emptyMoments } from './moments.js';
import type { Moments } from './moments.js';
import type { Assignment, ExposureEvent, GoalEvent, IdentityEvent } from './types.js';
import { addReward, type RewardSum } from './reward-sum.js';

/** First real exposure fixes these fields in the local exposure context. Repeated
 * exposures carry the same sample, including after a policy refresh. An assignment
 * that was never exposed cannot appear in the reducer's sample set.
 */
export interface SampleExposure {
  readonly event: ExposureEvent;
  readonly sampleId: string;
  readonly startAt: number;
  readonly attributionWindowMs: number;
}
export interface ClosedSample {
  readonly sampleId: string;
  readonly assignment: Assignment;
  readonly startAt: number;
  readonly endAt: number;
  readonly reward: number;
}
export interface ClosedArmMoments {
  readonly experimentId: string;
  readonly generation: number;
  readonly armId: string;
  readonly moments: Moments;
  readonly samples: number;
}
export interface ClosedCohort {
  /** Stable logical partition ID; never use query time or content hash as this ID. */
  readonly cohortId: string;
  readonly asOf: number;
  readonly samples: readonly ClosedSample[];
  readonly arms: readonly ClosedArmMoments[];
  readonly credits?: readonly (import('./types.js').Credit & { goalId: string; occurredAt: number })[];
}
export interface CohortInput {
  readonly cohortId: string;
  /** Select samples by their fixed endAt + allowedLatenessMs in [from, until). */
  readonly from: number;
  readonly until: number;
  /** Moment timestamp for this batch, fixed to the cohort end, not retry time. */
  readonly asOf: number;
  /** One site and a bounded query partition. Include all eligible concurrent
   * experiment exposures for its goals, even when their samples belong to another
   * cohort. Deduplicate IDs across the full query input, not individual pages.
   * Persist the query snapshot/result before applying; a retry must reuse it.
   */
  readonly exposures: readonly SampleExposure[];
  readonly goals: readonly GoalEvent[];
  readonly identities: readonly IdentityEvent[];
  readonly sampleIds?: readonly string[];
}

/** Pure reduction of one frozen raw snapshot. No reopening completed samples,
 * per-user durable ledger, state transfer or per-event aggregate writes.
 * Caller excludes inactive goals by event-time status before invoking this core.
 */
export function reduceClosedCohort(input: CohortInput): ClosedCohort {
  invariant(input.cohortId.length > 0 && Number.isSafeInteger(input.from) && input.from >= 0
    && Number.isSafeInteger(input.until) && input.until > input.from && input.asOf === input.until,
  'invalid_input', 'Invalid cohort interval');
  const histories = new IdentityHistory(input.identities);
  const selected = input.sampleIds === undefined ? undefined : new Set(input.sampleIds);
  const credits: (import('./types.js').Credit & { goalId: string; occurredAt: number })[] = [];
  const samples = new Map<string, ClosedSample>();
  const rewards = new Map<string, RewardSum>();
  const sampleDefinitions = new Map<string, string>();
  const byIdentity = new Map<string, Map<string, SampleExposure[]>>();
  const eventIds = new Set<string>();
  for (const exposure of input.exposures) {
    const { event, sampleId, startAt, attributionWindowMs } = exposure;
    invariant(!eventIds.has(event.eventId), 'conflict', 'Deduplicate raw events before reduction');
    eventIds.add(event.eventId);
    const assignment = event.assignment;
    const endAt = startAt + assignment.settings.observationWindowMs;
    const closesAt = endAt + assignment.settings.allowedLatenessMs;
    invariant(sampleId.length > 0 && Number.isSafeInteger(startAt) && startAt >= assignment.assignedAt
      && event.occurredAt >= startAt && event.occurredAt < endAt
      && Number.isSafeInteger(closesAt) && Number.isSafeInteger(attributionWindowMs) && attributionWindowMs > 0,
    'invalid_input', 'Invalid exposure sample context');
    // Even samples outside this closing partition need consistent contexts: they
    // affect equal splitting and must not be silently reassigned within the query.
    const definition = JSON.stringify([assignment, startAt, attributionWindowMs]);
    const previous = sampleDefinitions.get(sampleId);
    invariant(previous === undefined || previous === definition, 'conflict', 'Conflicting sample context');
    sampleDefinitions.set(sampleId, definition);
    if (closesAt >= input.from && closesAt < input.until && (!selected || selected.has(sampleId)) && !samples.has(sampleId)) {
      samples.set(sampleId, { sampleId, assignment, startAt, endAt, reward: 0 });
    }
    for (const owner of histories.exposureKeys(event)) {
      const byExperiment = byIdentity.get(owner) ?? new Map<string, SampleExposure[]>();
      const list = byExperiment.get(assignment.experimentId) ?? [];
      list.push(exposure);
      byExperiment.set(assignment.experimentId, list);
      byIdentity.set(owner, byExperiment);
    }
  }
  for (const byExperiment of byIdentity.values()) {
    for (const list of byExperiment.values()) list.sort((a, b) => compareEvents(a.event, b.event));
  }
  for (const goal of [...input.goals].sort(compareEvents)) {
    invariant(!eventIds.has(goal.eventId), 'conflict', 'Deduplicate raw events before reduction');
    eventIds.add(goal.eventId);
    finite(goal.value, 'Goal value');
    const eligible: SampleExposure[] = [];
    for (const exposures of byIdentity.get(histories.goalKey(goal.subject))?.values() ?? []) {
      // Input partitions must be bounded by the storage/query adapter. The index
      // skips future events; walking backwards handles login boundaries without
      // constructing a permanent user registry.
      let lo = 0, hi = exposures.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compareEvents(exposures[mid]!.event, goal) <= 0) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo - 1; i >= 0; i--) {
        const exposure = exposures[i]!;
        if (!histories.matches(exposure.event, goal)) continue;
        // Last actual exposure decides eligibility. Do not fall back to an older
        // exposure with a longer attribution window when this one has expired.
        if (goal.occurredAt - exposure.event.occurredAt <= exposure.attributionWindowMs) eligible.push(exposure);
        break;
      }
    }
    if (eligible.length === 0) continue;
    const baseValue = goal.value / eligible.length;
    for (const exposure of eligible) {
      const sample = samples.get(exposure.sampleId);
      // Closed/other-partition samples still count in the equal split above.
      if (!sample || goal.occurredAt < sample.startAt || goal.occurredAt >= sample.endAt) continue;
      const factor = decayFactor(goal.occurredAt - exposure.event.occurredAt, sample.assignment.settings.attributionHalfLifeMs);
      credits.push({ goalEventId: goal.eventId, goalId: goal.goalId, occurredAt: goal.occurredAt,
        experimentId: sample.assignment.experimentId, armId: sample.assignment.armId, exposureId: exposure.event.eventId,
        assignmentId: sample.assignment.assignmentId, observationId: sample.sampleId, experimentCount: eligible.length,
        baseValue, decayFactor: factor, value: baseValue * factor, learningEligible: true, learningClosed: true });
      const reward = rewards.get(sample.sampleId) ?? { scale: 0, sum: 0, correction: 0 };
      addReward(reward, baseValue * factor);
      rewards.set(sample.sampleId, reward);
    }
  }
  for (const [sampleId, reward] of rewards) {
    samples.set(sampleId, { ...samples.get(sampleId)!, reward: finite((reward.sum + reward.correction) * reward.scale, 'Sample reward') });
  }
  return { cohortId: input.cohortId, asOf: input.asOf, samples: [...samples.values()], arms: closedSampleMoments([...samples.values()], input.asOf), credits };
}

/** Preserve each observation's original evaluation time when folding batch results. */
export function closedSampleMoments(samples: readonly ClosedSample[], asOf: number): ClosedArmMoments[] {
  const arms = new Map<string, ClosedArmMoments>();
  for (const sample of samples) {
    const { experimentId, generation, armId, settings } = sample.assignment;
    const key = JSON.stringify([experimentId, generation, armId]);
    const previous = arms.get(key) ?? { experimentId, generation, armId, moments: emptyMoments(asOf), samples: 0 };
    // A late batch is never fresh evidence: age from evaluation end, not query time.
    const weight = decayFactor(asOf - sample.endAt, settings.learningHalfLifeMs);
    arms.set(key, { ...previous, moments: addSample(previous.moments, sample.reward, weight), samples: previous.samples + 1 });
  }
  return [...arms.values()];
}
