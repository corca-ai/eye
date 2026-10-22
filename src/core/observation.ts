import { invariant } from './errors.js';
import type { Assignment, Attributes, Observation } from './types.js';

/** Fixed windows never slide with repeat exposure or produce phantom zero windows. */
export function openObservation(assignment: Assignment, subjectKey: string, exposureId: string, occurredAt: number, attributes: Attributes): Observation {
  invariant(occurredAt >= assignment.assignedAt, 'invalid_input', 'Exposure predates assignment');
  return {
    // Tuple avoids separator collisions; IDs are deterministically reproducible on retry.
    observationId: JSON.stringify([assignment.assignmentId, exposureId]),
    assignmentId: assignment.assignmentId, subjectKey, experimentId: assignment.experimentId,
    armId: assignment.armId, generation: assignment.generation, revision: 1,
    startAt: occurredAt, endAt: occurredAt + assignment.settings.observationWindowMs,
    status: 'pending', reward: 0, attributes,
  };
}
export function canReassign(assignment: Assignment, observation: Observation | undefined, now: number): boolean {
  const holdUntil = assignment.assignedAt + assignment.settings.minHoldMs;
  const end = observation?.status === 'pending' ? observation.endAt : 0;
  return now >= Math.max(holdUntil, end);
}
export function closeObservation(observation: Observation, now: number, allowedLatenessMs: number): Observation {
  if (observation.status !== 'pending' || now < observation.endAt + allowedLatenessMs) return observation;
  return { ...observation, status: 'complete', revision: observation.revision + 1 };
}
export function interruptObservation(observation: Observation, at: number, reason: NonNullable<Observation['interruptReason']>): Observation {
  if (at >= observation.endAt || observation.status === 'interrupted') return observation;
  invariant(at >= observation.startAt, 'invalid_input', 'Interruption predates observation');
  return { ...observation, status: 'interrupted', interruptReason: reason, revision: observation.revision + 1 };
}
