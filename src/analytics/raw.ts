import { invariant } from '../core/errors.js';
import { hasExposureContext, observationEndAt, observationCloseAt } from '../core/sample-context.js';
import { subjectKey } from '../core/validation.js';
import type { EventEnvelope } from '../core/types.js';
import { analyticsRecord, type AnalyticsRecord } from './records.js';

export function validateRawEnvelope(envelope: EventEnvelope): void {
  if (envelope.event.kind === 'exposure') invariant(hasExposureContext(envelope.event),
    'invalid_input', 'Exposure requires sample and attribution context');
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
    { ...event, ...(event.kind === 'exposure' ? { projectionSubjectKey: context.subjectKey, sampleId: event.sample!.sampleId, startAt: event.sample!.startAt, endAt: observationEndAt(event.sample!.startAt, event.assignment.settings.observationWindowMs), closeAt: observationCloseAt(event.sample!.startAt, event.assignment.settings.observationWindowMs) } : {}), processingStatus: accepted ? 'accepted' : 'inactive' }, { ...fields, status: accepted ? 'accepted' : 'inactive' }, event.attributes)];
  if (event.kind === 'identify' || event.kind === 'logout') result.push(analyticsRecord(context, 'identity_links', event.eventId, 1,
    event.occurredAt, receivedAt, event, { status: event.kind }));
  // Pending observations and selected decisions are reconstructed from these
  // durable receipts. Learning still exports one finalized observation.
  return result;
}
