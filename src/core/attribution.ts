import { finite, invariant } from './errors.js';
import { decayFactor } from './moments.js';
import type { Credit, Exposure, GoalEvent, Observation } from './types.js';

/** Input contains exactly the last exposure at/before goal time for each experiment. */
export function attributeGoal(
  goal: Pick<GoalEvent, 'eventId' | 'occurredAt' | 'value'>,
  exposures: readonly Exposure[],
  observations: ReadonlyMap<string, Observation>,
): Credit[] {
  finite(goal.value, 'Goal value');
  invariant(new Set(exposures.map(e => e.assignment.experimentId)).size === exposures.length, 'invalid_input', 'Expected one last exposure per experiment');
  if (exposures.length === 0) return [];
  const baseValue = goal.value / exposures.length;
  return exposures.map(exposure => {
    invariant(exposure.occurredAt <= goal.occurredAt, 'invalid_input', 'Exposure cannot follow the goal');
    const a = exposure.assignment;
    const factor = decayFactor(goal.occurredAt - exposure.occurredAt, a.settings.attributionHalfLifeMs);
    const observation = exposure.observationId === null ? undefined : observations.get(exposure.observationId);
    const learningEligible = observation !== undefined && observation.status !== 'interrupted'
      && observation.startAt <= goal.occurredAt && goal.occurredAt < observation.endAt
      && observation.armId === a.armId && observation.assignmentId === a.assignmentId;
    return {
      goalEventId: goal.eventId, experimentId: a.experimentId, armId: a.armId,
      exposureId: exposure.eventId, assignmentId: a.assignmentId, observationId: exposure.observationId,
      experimentCount: exposures.length, baseValue, decayFactor: factor, value: baseValue * factor, learningEligible,
    };
  });
}

/** Deterministic event-time ordering. Equal timestamps are ordered by stable event ID. */
export function compareEvents(a: { occurredAt: number; eventId: string }, b: { occurredAt: number; eventId: string }): number {
  return a.occurredAt - b.occurredAt || compareIdentifiers(a.eventId, b.eventId);
}

/** SQLite BINARY compares UTF-8 bytes, whose order agrees with Unicode scalar values,
 * not JavaScript's UTF-16 code units for supplementary characters. */
export function compareIdentifiers(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!, y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1; j += y > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : -1;
}

/** Binary search over sorted exposure history; never uses a future exposure. */
export function lastExposureBefore(exposures: readonly Exposure[], occurredAt: number): Exposure | undefined {
  let lo = 0, hi = exposures.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (exposures[mid]!.occurredAt <= occurredAt) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? undefined : exposures[lo - 1];
}
