import { EyeError, invariant } from './errors.js';
import { observationEndAt } from './sample-context.js';
import { EVENT_MAX_AGE_MS, historicalSettings, attributes, id, number, record, RETENTION_MS, settings, subject, timestamp, sampleId } from './validation.js';
import type { Assignment, CreateExperiment, EventEnvelope, EyeEvent } from './types.js';
import type { CollectionLimits } from '../collection-limits.js';

export function parseAssignment(value: unknown): Assignment {
  const v = record(value, 'assignment');
  const generation = timestamp(v.generation, 'generation');
  const probability = number(v.probability, 'probability');
  invariant(generation >= 1 && probability > 0 && probability <= 1, 'invalid_input', 'Invalid assignment generation or probability');
  const parsedSettings = historicalSettings(v.settings);
  return {
    assignmentId: id(v.assignmentId, 'assignmentId'), experimentId: id(v.experimentId, 'experimentId'),
    armId: id(v.armId, 'armId'), generation, assignedAt: timestamp(v.assignedAt, 'assignedAt'),
    policyRevision: timestamp(v.policyRevision, 'policyRevision'), probability, settings: parsedSettings,
  };
}
export function parseEvent(value: unknown, limits?: CollectionLimits): EyeEvent {
  const v = record(value, 'event');
  const base = {
    eventId: id(v.eventId, 'eventId'), occurredAt: timestamp(v.occurredAt, 'occurredAt'), subject: subject(v.subject),
    ...(v.attributes === undefined ? {} : { attributes: attributes(v.attributes, limits) }),
  };
  switch (v.kind) {
    case 'track': return { ...base, kind: 'track', name: id(v.name, 'name') };
    case 'goal': return { ...base, kind: 'goal', goalId: id(v.goalId, 'goalId'), value: number(v.value, 'value') };
    case 'exposure': {
      const assignment = parseAssignment(v.assignment);
      invariant(base.occurredAt >= assignment.assignedAt, 'invalid_input', 'Exposure predates assignment');
      const sample = v.sample === undefined ? undefined : record(v.sample, 'sample');
      const sampleValue = sample === undefined ? undefined : { sampleId: sampleId(sample.sampleId), startAt: timestamp(sample.startAt, 'sample.startAt') };
      if (sampleValue) invariant(sampleValue.startAt >= assignment.assignedAt && base.occurredAt >= sampleValue.startAt
        && base.occurredAt < observationEndAt(sampleValue.startAt, assignment.settings.observationWindowMs), 'invalid_input', 'Invalid sample interval');
      const horizon = v.attributionWindowMs === undefined ? undefined : timestamp(v.attributionWindowMs, 'attributionWindowMs');
      if (horizon !== undefined) invariant(horizon > 0 && horizon <= RETENTION_MS, 'invalid_input', 'Invalid attribution horizon');
      return {
      ...(sampleValue === undefined ? {} : { sample: sampleValue }), ...(horizon === undefined ? {} : { attributionWindowMs: horizon }),
      ...base, kind: 'exposure', assignment,
      ...(v.userAttributes === undefined ? {} : { userAttributes: attributes(v.userAttributes, limits) }),
    };
    }
    case 'identify':
      invariant(base.subject.uid !== undefined, 'invalid_input', 'identify requires uid');
      return { ...base, kind: 'identify' };
    case 'logout': return { ...base, kind: 'logout' };
    default: throw new EyeError('invalid_input', 'Unknown event kind');
  }
}
export function parseEnvelope(value: unknown, now: number, limits?: CollectionLimits): EventEnvelope {
  const v = record(value, 'envelope');
  const event = parseEvent(v.event, limits);
  const siteId = id(v.siteId, 'siteId');
  const receivedAt = timestamp(v.receivedAt, 'receivedAt');
  invariant(event.occurredAt >= now - RETENTION_MS, 'outside_retention', 'Event is older than 60 days');
  // Ordering must not depend on when Queue retries a message. Receipt time is immutable.
  invariant(event.occurredAt <= receivedAt && receivedAt <= now, 'invalid_input', 'Event time cannot be after receipt time or in the future');
  return { siteId, receivedAt, event };
}
export function parseCreateExperiment(value: unknown): CreateExperiment & { settings: ReturnType<typeof settings> } {
  const v = record(value, 'experiment');
  invariant(Array.isArray(v.arms) && v.arms.length > 0, 'invalid_input', 'At least one arm is required');
  const arms = Array.from(v.arms, (a: unknown) => id(a, 'armId'));
  invariant(new Set(arms).size === arms.length, 'invalid_input', 'Arm IDs must be unique');
  return { experimentId: id(v.experimentId, 'experimentId'), arms, settings: settings(v.settings) };
}

/** External admission only. Queue retries preserve their original server receipt. */
export function validateEventAge(event: EyeEvent, receivedAt: number): void {
  invariant(event.occurredAt <= receivedAt && receivedAt - event.occurredAt <= EVENT_MAX_AGE_MS,
    'invalid_input', 'Events must arrive within 15 seconds of occurrence');
}
