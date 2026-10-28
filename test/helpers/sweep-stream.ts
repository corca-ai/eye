import { rawRecords } from '../../src/analytics/raw.js';
import { settings } from '../../src/core/validation.js';
import type { EyeEvent } from '../../src/core/types.js';
export const SWEEP_NOW = 1_800_000_000_000, SWEEP_START = SWEEP_NOW - 100_000;
export function sweepStream(seed: number) {
  let state = seed;
  const draw = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return Math.floor(state / 4_294_967_296 * n); };
  const events: EyeEvent[] = [];
  for (let i = 0; i < 180; i++) {
    const subject = { cid: `c-${draw(4)}`, ...(draw(3) ? { uid: `u-${draw(3)}` } : {}) };
    const at = SWEEP_START + draw(100), eventId = `${i % 17 ? 'id' : '😀'}-${i}`;
    switch (i % 4) {
      case 0: {
        const config = settings({ minHoldMs: 0, observationWindowMs: 10 + draw(90), attributionHalfLifeMs: 20 + draw(80) });
        events.push({ kind: 'exposure', eventId, occurredAt: at, subject,
          assignment: { assignmentId: eventId, experimentId: `exp-${draw(4)}`, armId: `arm-${draw(2)}`, generation: 1 + draw(2),
            assignedAt: at, probability: .5, policyRevision: 1, settings: config },
          sample: { sampleId: `sample-${i}`, startAt: at }, attributionWindowMs: 1 + draw(80), userAttributes: { group: `g-${draw(2)}` } });
        break;
      }
      case 1: events.push({ kind: 'goal', eventId, occurredAt: at, subject, goalId: `goal-${draw(2)}`, value: draw(101) - 30 }); break;
      case 2: events.push({ kind: 'track', eventId, occurredAt: at, subject, name: draw(2) ? 'view' : 'click', attributes: { x: draw(4) } }); break;
      case 3: events.push(subject.uid ? { kind: 'identify', eventId, occurredAt: at, subject }
        : { kind: 'logout', eventId, occurredAt: at, subject }); break;
    }
  }
  const records = events.flatMap((event, i) => rawRecords({ siteId: 'site', receivedAt: SWEEP_NOW - 10 + i % 5, event }));
  return { events, records: records.flatMap((row, i) => i % 7 ? [row] : [row, { ...row, received_at: SWEEP_NOW }]) };
}
