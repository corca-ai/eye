import { invariant } from '../core/errors.js';
import { subjectKey } from '../core/validation.js';
import type { EventEnvelope } from '../core/types.js';
import { analyticsRecord, type AnalyticsRecord } from './records.js';

export function validateRawEnvelope(envelope: EventEnvelope): void {
  if (envelope.event.kind === 'exposure') invariant(envelope.event.sample && envelope.event.attributionWindowMs,
    'invalid_input', 'Exposure requires local sample context; upgrade the host SDK');
}
/** Derived projections share the same Stream ingestion, not independent writes.
 * Stable IDs allow analytic deduplication across Queue retries/batches.
 */
export function rawRecords({ siteId, receivedAt, event }: EventEnvelope, accepted = true): AnalyticsRecord[] {
  const context = { siteId, subjectKey: subjectKey(siteId, event.subject), ...event.subject };
  const fields = event.kind === 'goal' ? { goal_id: event.goalId, value: event.value }
    : event.kind === 'exposure' ? { experiment_id: event.assignment.experimentId, arm_id: event.assignment.armId,
      assignment_id: event.assignment.assignmentId, observation_id: event.sample!.sampleId } : {};
  const result = [analyticsRecord(context, 'events', event.eventId, 1, event.occurredAt, receivedAt,
    { ...event, ...(event.kind === 'exposure' ? { sampleId: event.sample!.sampleId, startAt: event.sample!.startAt, endAt: event.sample!.startAt + event.assignment.settings.observationWindowMs, closeAt: event.sample!.startAt + event.assignment.settings.observationWindowMs + event.assignment.settings.allowedLatenessMs } : {}), processingStatus: accepted ? 'accepted' : 'inactive' }, { ...fields, status: accepted ? 'accepted' : 'inactive' }, event.attributes)];
  if (event.kind === 'identify' || event.kind === 'logout') result.push(analyticsRecord(context, 'identity_links', event.eventId, 1,
    event.occurredAt, receivedAt, event, { status: event.kind }));
  if (event.kind === 'exposure') {
    const a = event.assignment, sample = event.sample!;
    result.push(analyticsRecord(context, 'observations', sample.sampleId, 1, sample.startAt, receivedAt,
      { observationId: sample.sampleId, assignmentId: a.assignmentId, subjectKey: context.subjectKey, subject: event.subject,
        experimentId: a.experimentId, armId: a.armId, generation: a.generation, startAt: sample.startAt,
        endAt: sample.startAt + a.settings.observationWindowMs, closeAt: sample.startAt + a.settings.observationWindowMs + a.settings.allowedLatenessMs,
        assignment: a, status: 'pending', reward: 0 }, { ...fields, status: 'pending', value: 0 }, event.userAttributes));
    result.push(analyticsRecord(context, 'decisions', a.assignmentId, 1, a.assignedAt, receivedAt,
      { assignment: a, reason: 'selected', probability: a.probability, generation: a.generation }, { ...fields, status: 'selected' }));
  }
  return result;
}
