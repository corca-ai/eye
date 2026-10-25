import { rawRecords } from '../../src/analytics/raw.js';
import { settings } from '../../src/core/validation.js';
import type { EyeEvent, ExposureEvent, Subject } from '../../src/core/types.js';
export const TEMPORAL_NOW = 1_800_000_000_000, TEMPORAL_START = TEMPORAL_NOW - 100_000;
const config = settings({ minHoldMs: 0, observationWindowMs: 10_000, allowedLatenessMs: 0 });
export const temporalExposure = (eventId: string, at: number, subject: Subject, experimentId = 'exp', horizon = 10_000): ExposureEvent => ({
  kind: 'exposure', eventId, occurredAt: at, subject,
  assignment: { assignmentId: eventId, experimentId, armId: 'a', generation: 1, policyRevision: 1, assignedAt: at, probability: 1, settings: config },
  sample: { sampleId: eventId, startAt: at }, attributionWindowMs: horizon,
});
export function hotSubjectStream(count: number, unrelated = 0) {
  const events: EyeEvent[] = [];
  for (let user = 0; user <= unrelated; user++) {
    const subject = { cid: `c-${user}`, uid: `u-${user}` };
    for (let i = 0; i < (user ? 4 : count); i++) {
      const at = TEMPORAL_START + i * 2;
      events.push(temporalExposure(`${user}-e-${i}`, at, subject, user ? 'noise' : 'exp'),
        { kind: 'goal', eventId: `${user}-g-${i}`, occurredAt: at + 1, subject, goalId: 'pay', value: 1 });
    }
  }
  return events.flatMap(event => rawRecords({ siteId: 'site', receivedAt: TEMPORAL_NOW, event }));
}
