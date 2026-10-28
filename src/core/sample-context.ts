import { OBSERVATION_GRACE_MS } from './validation.js';
import type { Assignment, ExposureEvent } from './types.js';

/** Wire exposure after the collection boundary has required its sample context.
 * An assignment that has not been exposed may still have no sample. */
export type SampledExposureEvent = ExposureEvent & {
  sample: NonNullable<ExposureEvent['sample']>;
  attributionWindowMs: number;
};

/** Presence check for an already parsed exposure, not a replacement for parsing. */
export function hasExposureContext(event: ExposureEvent): event is SampledExposureEvent {
  return Boolean(event.sample && event.attributionWindowMs);
}

export function observationEndAt(startAt: number, windowMs: number): number {
  return startAt + windowMs;
}

export function observationCloseAt(startAt: number, windowMs: number): number {
  return observationEndAt(startAt, windowMs) + OBSERVATION_GRACE_MS;
}

/** Full immutable definition, independent of the earliest receipt's attributes.
 * The learner's narrow metadata query reads this tuple without loading receipts. */
export function sampleDefinition(assignment: Assignment, startAt: number, attributionWindowMs: number): string {
  return JSON.stringify([assignment, startAt, attributionWindowMs]);
}
