import { EyeError, invariant } from './errors.js';
import { attributes, id, number, record, RETENTION_MS, settings, subject, timestamp, sampleId } from './validation.js';
import type { Assignment, CreateExperiment, EventEnvelope, EyeEvent } from './types.js';

export function parseAssignment(value: unknown): Assignment {
  const v = record(value, 'assignment');
  const generation = timestamp(v.generation, 'generation');
  const probability = number(v.probability, 'probability');
  invariant(generation >= 1 && probability > 0 && probability <= 1, 'invalid_input', 'Invalid assignment generation or probability');
  const parsedSettings = settings(v.settings);
  return {
    assignmentId: id(v.assignmentId, 'assignmentId'), experimentId: id(v.experimentId, 'experimentId'),
    armId: id(v.armId, 'armId'), generation, assignedAt: timestamp(v.assignedAt, 'assignedAt'),
    policyRevision: timestamp(v.policyRevision, 'policyRevision'), probability, settings: parsedSettings,
  };
}
export function parseEvent(value: unknown): EyeEvent {
  const v = record(value, 'event');
  const base = {
    eventId: id(v.eventId, 'eventId'), occurredAt: timestamp(v.occurredAt, 'occurredAt'), subject: subject(v.subject),
    ...(v.attributes === undefined ? {} : { attributes: attributes(v.attributes) }),
  };
  switch (v.kind) {
    case 'track': return { ...base, kind: 'track', name: id(v.name, 'name') };
    case 'goal': return { ...base, kind: 'goal', goalId: id(v.goalId, 'goalId'), value: number(v.value, 'value') };
    case 'exposure': {
      invariant(v.routingKey === undefined || (typeof v.routingKey === 'string' && v.routingKey.length <= 2048), 'invalid_input', 'Invalid exposure routing key');
      const assignment = parseAssignment(v.assignment);
      invariant(base.occurredAt >= assignment.assignedAt, 'invalid_input', 'Exposure predates assignment');
      const sample = v.sample === undefined ? undefined : record(v.sample, 'sample');
      const sampleValue = sample === undefined ? undefined : { sampleId: sampleId(sample.sampleId), startAt: timestamp(sample.startAt, 'sample.startAt') };
      if (sampleValue) invariant(sampleValue.startAt >= assignment.assignedAt && base.occurredAt >= sampleValue.startAt
        && base.occurredAt < sampleValue.startAt + assignment.settings.observationWindowMs, 'invalid_input', 'Invalid sample interval');
      const horizon = v.attributionWindowMs === undefined ? undefined : timestamp(v.attributionWindowMs, 'attributionWindowMs');
      if (horizon !== undefined) invariant(horizon > 0 && horizon <= RETENTION_MS, 'invalid_input', 'Invalid attribution horizon');
      return {
      ...(sampleValue === undefined ? {} : { sample: sampleValue }), ...(horizon === undefined ? {} : { attributionWindowMs: horizon }),
      ...base, kind: 'exposure', assignment,
      ...(v.routingKey === undefined ? {} : { routingKey: v.routingKey }),
      ...(v.userAttributes === undefined ? {} : { userAttributes: attributes(v.userAttributes) }),
    };
    }
    case 'identify':
      invariant(base.subject.uid !== undefined, 'invalid_input', 'identify requires uid');
      return { ...base, kind: 'identify' };
    case 'logout': return { ...base, kind: 'logout' };
    default: throw new EyeError('invalid_input', 'Unknown event kind');
  }
}
export function parseEnvelope(value: unknown, now: number): EventEnvelope {
  const v = record(value, 'envelope');
  const event = parseEvent(v.event);
  const siteId = id(v.siteId, 'siteId');
  if (event.kind === 'exposure' && event.routingKey !== undefined) {
    let route: unknown;
    try { route = JSON.parse(event.routingKey); } catch { throw new EyeError('invalid_input', 'Invalid exposure routing key'); }
    invariant(Array.isArray(route) && route[0] === siteId && route.every(item => typeof item === 'string') &&
      ((route.length === 3 && (route[1] === 'cid' || route[1] === 'uid')) || (route.length === 4 && route[1] === 'anonymous')),
    'invalid_input', 'Exposure route does not belong to this site or subject namespace');
  }
  const receivedAt = timestamp(v.receivedAt, 'receivedAt');
  invariant(event.occurredAt >= now - RETENTION_MS, 'outside_retention', 'Event is older than 60 days');
  // Ordering must not depend on when Queue retries a message. Receipt time is immutable.
  invariant(event.occurredAt <= receivedAt && receivedAt <= now, 'invalid_input', 'Event time cannot be after receipt time or in the future');
  return { siteId, receivedAt, event };
}
export function parseCreateExperiment(value: unknown): CreateExperiment & { settings: ReturnType<typeof settings> } {
  const v = record(value, 'experiment');
  invariant(Array.isArray(v.arms) && v.arms.length > 0, 'invalid_input', 'At least one arm is required');
  const arms = v.arms.map((a: unknown) => id(a, 'armId'));
  invariant(new Set(arms).size === arms.length, 'invalid_input', 'Arm IDs must be unique');
  return { experimentId: id(v.experimentId, 'experimentId'), arms, settings: settings(v.settings) };
}
