import { rawRecords } from '../../src/analytics/raw.js';
import { settings } from '../../src/core/validation.js';
import type { EyeEvent, ExposureEvent } from '../../src/core/types.js';
export const QUERY_NOW = 1_800_000_000_000, QUERY_DAY = 86_400_000;
/** Immutable IDs, retries, anonymous/UID and first-login ownership, long horizons,
 * short latest-touch horizons, signed goals and many unrelated track events. */
export function queryStream(users: number, seed = 1) {
  const events: EyeEvent[] = [];
  const config = settings({ minHoldMs: 0, observationWindowMs: 3 * QUERY_DAY, attributionHalfLifeMs: QUERY_DAY });
  for (let i = 0; i < users; i++) {
    const prefix = `${seed}-${i}`, cid = `c-${prefix}`, uid = `u-${prefix}`;
    const subject = i % 3 === 0 ? { cid, uid } : { cid };
    const at = QUERY_NOW - 2 * QUERY_DAY + (i % 20) * 1000;
    const exposure = (suffix: string, occurredAt: number, experimentId: string, horizon: number): ExposureEvent => ({
      kind: 'exposure', eventId: `${prefix}-${suffix}`, subject, occurredAt,
      assignment: { assignmentId: `${prefix}-${suffix}`, experimentId, armId: i % 2 ? 'a' : 'b', generation: 1,
        assignedAt: occurredAt - 100, policyRevision: 1, probability: .5, settings: config },
      sample: { sampleId: `${prefix}-${suffix}`, startAt: occurredAt }, attributionWindowMs: horizon,
      userAttributes: { locale: 'ko', seed },
    });
    events.push(exposure('old', at - 10 * QUERY_DAY, 'exp', 30 * QUERY_DAY));
    const first = exposure('first', at, 'exp', 3 * QUERY_DAY);
    events.push(first, { ...first, eventId: `${prefix}-repeat`, occurredAt: at + 20, userAttributes: { locale: 'en' } },
      exposure('other', at + 20, 'other', 3 * QUERY_DAY));
    // A latest exposure with expired horizon must not revive an older eligible one.
    if (i % 7 === 0) events.push(exposure('short', at + 30, 'exp', 1));
    if (i % 3 === 1) events.push({ kind: 'identify', eventId: `${prefix}-login`, subject: { cid, uid }, occurredAt: at + 50 });
    const goalSubject = i % 3 === 1 ? { cid: `second-${cid}`, uid } : subject;
    for (let j = 0; j < 2; j++) events.push({ kind: 'goal', eventId: `${prefix}-goal-${j}`, subject: goalSubject,
      occurredAt: at + (j ? QUERY_DAY : 50), goalId: 'pay', value: j ? -30 : 100 });
    if (i % 3 === 1) events.push({ kind: 'logout', eventId: `${prefix}-logout`, subject: { cid }, occurredAt: at + QUERY_DAY + 10 },
      { kind: 'identify', eventId: `${prefix}-next-login`, subject: { cid, uid: `next-${uid}` }, occurredAt: at + QUERY_DAY + 20 },
      { kind: 'goal', eventId: `${prefix}-next-goal`, subject: { cid, uid: `next-${uid}` }, occurredAt: at + QUERY_DAY + 30, goalId: 'pay', value: 10000 });
    for (let j = 0; j < 20; j++) events.push({ kind: 'track', eventId: `${prefix}-track-${j}`, subject,
      occurredAt: QUERY_NOW - (j + 1) * QUERY_DAY, name: 'view' });
  }
  // The raw snapshot can contain repeated immutable receipts and delayed arrivals.
  return events.flatMap((event, i) => rawRecords({ siteId: 'site', receivedAt: QUERY_NOW - 100 + i % 10, event }))
    .flatMap((record, i) => i % 11 ? [record] : [record, { ...record, received_at: QUERY_NOW - 1 }]);
}
