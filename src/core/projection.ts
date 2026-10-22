import { closeObservation, interruptObservation, openObservation } from './observation.js';
import type { Assignment, ExposureEvent, Observation } from './types.js';

export interface AssignmentLifetime {
  assignment: Assignment;
  retiredAt: number | null;
  reason: NonNullable<Observation['interruptReason']> | null;
}
export interface ProjectedExposure { event: ExposureEvent; observationId: string | null }
export interface ExperimentProjection { observations: Observation[]; exposures: ProjectedExposure[] }

/** Replay is only for late exposures; the ordered ingestion path projects one event. */
export function projectExposure(
  event: ExposureEvent, lifetime: AssignmentLifetime, subjectKey: string, now: number,
  previous: Observation | undefined,
): { observation: Observation | null; opened: boolean } {
  const { assignment, retiredAt, reason } = lifetime;
  if (retiredAt !== null && event.occurredAt >= retiredAt) return { observation: null, opened: false };
  if (previous && previous.assignmentId === assignment.assignmentId
      && previous.startAt <= event.occurredAt && event.occurredAt < previous.endAt) return { observation: previous, opened: false };
  let observation: Observation = { ...openObservation(assignment, subjectKey, event.eventId, event.occurredAt, event.userAttributes ?? {}), subject: event.subject };
  if (retiredAt !== null && retiredAt < observation.endAt) observation = interruptObservation(observation, retiredAt, reason ?? 'configuration');
  observation = closeObservation(observation, now, assignment.settings.allowedLatenessMs);
  return { observation, opened: true };
}
export function projectExperiment(
  events: Iterable<ExposureEvent>, lifetimes: ReadonlyMap<string, AssignmentLifetime>, subjectKey: string, now: number,
): ExperimentProjection {
  const observations: Observation[] = [], exposures: ProjectedExposure[] = [];
  // A stale page may report an old assignment after a newer assignment. Keep histories independent.
  const lastByAssignment = new Map<string, Observation>();
  for (const event of events) {
    const lifetime = lifetimes.get(event.assignment.assignmentId);
    if (!lifetime) throw new Error('Exposure references an unknown assignment');
    const result = projectExposure(event, lifetime, subjectKey, now, lastByAssignment.get(event.assignment.assignmentId));
    if (result.observation) {
      lastByAssignment.set(event.assignment.assignmentId, result.observation);
      if (result.opened) observations.push(result.observation);
    }
    exposures.push({ event, observationId: result.observation?.observationId ?? null });
  }
  return { observations, exposures };
}
