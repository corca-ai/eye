import type { AnalyticsRecord } from '../../src/analytics/records.js';
import { learningDatabase } from '../helpers/learning-db.js';
import { compareEvents } from '../../src/core/attribution.js';
import { AnalyticsSQL } from '../../src/analytics/sql.js';
import { AnalyticsSQL as ReferenceSQL } from '../../benchmarks/analytics/reference-sweep-sql.js';
import { sweepStream, SWEEP_NOW, SWEEP_START } from '../helpers/sweep-stream.js';
import type { ArmQuery } from '../../src/analytics/types.js';
import { expect, it } from 'vitest';
import { attributionCTEs } from '../../src/analytics/attribution-sql.js';
import { attributionCTEs as reference } from '../../benchmarks/analytics/reference-sweep-attribution.js';
import { database } from '../helpers/analytics-db.js';
import { rawRecords } from '../../src/analytics/raw.js';
import { temporalExposure, TEMPORAL_NOW as now, TEMPORAL_START as start } from '../helpers/temporal-stream.js';
import type { EyeEvent } from '../../src/core/types.js';

it('numbers previous and next identity boundaries exactly, including same-time IDs and duplicate receipts', () => {
  const events: EyeEvent[] = [];
  for (let i = 0; i < 40; i++) events.push({ kind: i % 3 ? 'identify' : 'logout', eventId: `i-${i}`,
    occurredAt: start + i * 2, subject: { cid: 'c', ...(i % 3 ? { uid: `u-${i % 4}` } : {}) } });
  for (let i = 0; i < 100; i++) events.push(temporalExposure(`e-${i}`, start + i, { cid: 'c' }));
  const rows = events.flatMap(event => rawRecords({ siteId: 'site', receivedAt: now, event }));
  const db = database([...rows, ...rows]);
  try {
    const args = ['eye', "'site'", now - 60 * 86_400_000, start, now, now] as const;
    const select = 'SELECT b.exposure_key,b.previous_kind,a.next_kind,a.next_uid,a.next_at,a.next_id FROM ac_before b JOIN ac_after a ON a.exposure_key=b.exposure_key ORDER BY b.exposure_key';
    expect(db.run(`WITH ${attributionCTEs(...args).join(',')} ${select}`)).toEqual(db.run(`WITH ${reference(...args).join(',')} ${select}`));
  } finally { db.close(); }
});

it('counts target attribution using interval overlap with expiry, late anonymous claims and simultaneous endpoints', () => {
  const uid = { cid: 'device', uid: 'u' };
  const events: EyeEvent[] = [
    temporalExposure('a-old', start, { cid: 'anon' }, 'exp', 100),
    temporalExposure('b-new-short', start + 5, uid, 'exp', 1),
    { kind: 'identify', eventId: 'c-late-claim', occurredAt: start + 8, subject: { cid: 'anon', uid: 'u' } },
    temporalExposure('d-anon-one', start + 10, { cid: 'c' }, 'one', 4),
    temporalExposure('e-anon-two', start + 10, { cid: 'c' }, 'two', 4),
    { kind: 'identify', eventId: 'f-login', occurredAt: start + 14, subject: { cid: 'c', uid: 'u' } },
    ...[5, 6, 7, 8, 14, 15].map((offset): EyeEvent => ({ kind: 'goal', eventId: `z-goal-${offset}`, occurredAt: start + offset,
      subject: uid, goalId: 'pay', value: 100 })),
  ];
  const db = database(events.flatMap(event => rawRecords({ siteId: 'site', receivedAt: now, event })));
  try {
    const args = ['eye', "'site'", now - 60 * 86_400_000, start, now, now] as const;
    const old = reference(...args), next = attributionCTEs(...args, undefined, "'one'");
    const expectedCounts = db.run(`WITH ${old.join(',')} SELECT g.record_id, (SELECT COUNT(*) FROM ac_eligible a WHERE a.goal_event_id=g.record_id) AS n FROM ac_goals g ORDER BY g.record_id`);
    const counts = db.run(`WITH ${next.join(',')} SELECT goal_event_id AS record_id, experiment_count AS n FROM ac_goal_counts ORDER BY goal_event_id`);
    expect(counts).toEqual(expectedCounts);
    expect(counts.map(row => row.n)).toEqual([2, 0, 1, 1, 0, 0]); // IDs sort lexically: 14,15,5,6,7,8.
    const query = (ctes: string[]) => `WITH ${ctes.join(',')} SELECT * FROM credits_latest WHERE experiment_id='one' ORDER BY record_id`;
    expect(db.run(query(next))).toEqual(db.run(query(old)));
  } finally { db.close(); }
});


it.each([1, 7, 29, 103, 1234, 7159, 65537, 3735928559])('matches all identity/count/credit paths and hasEvent queries on mixed streams (seed %s)', seed => {
  const { records, events } = sweepStream(seed), learner = learningDatabase();
  let closed: AnalyticsRecord[];
  try {
    for (const event of [...events].sort(compareEvents)) learner.engine.accept([event], event.occurredAt);
    learner.engine.close('site', SWEEP_NOW, () => {});
    closed = learner.engine.outputs().flatMap(item => item.output.records);
  } finally { learner.close(); }
  expect(closed.length).toBeGreaterThan(0);
  const db = database([...records, ...closed]);
  try {
    const args = ['eye', "'site'", SWEEP_NOW - 60 * 86_400_000, SWEEP_START, SWEEP_NOW, SWEEP_NOW - 2] as const;
    const old = reference(...args);
    expect(db.run(`WITH ${old.join(',')} SELECT COUNT(*) AS n FROM credits_latest`)[0]!.n).toBeGreaterThan(0);
    for (const experiment of ['exp-0', 'exp-1', 'exp-2', 'exp-3', 'missing']) {
      const next = attributionCTEs(...args, undefined, `'${experiment}'`);
      const credits = (ctes: string[]) => `WITH ${ctes.join(',')} SELECT * FROM credits_latest WHERE experiment_id='${experiment}' ORDER BY record_id`;
      expect(db.run(credits(next))).toEqual(db.run(credits(old)));
      const expectedCounts = db.run(`WITH ${old.join(',')} SELECT g.record_id, (SELECT COUNT(*) FROM ac_eligible a WHERE a.goal_event_id=g.record_id) AS n FROM ac_goals g ORDER BY g.record_id`);
      expect(db.run(`WITH ${next.join(',')} SELECT goal_event_id AS record_id, experiment_count AS n FROM ac_goal_counts ORDER BY goal_event_id`)).toEqual(expectedCounts);
    }
    const next = new AnalyticsSQL('eye', 'site', SWEEP_NOW), baseline = new ReferenceSQL('eye', 'site', SWEEP_NOW);
    for (const hasEvent of [undefined, { name: 'view' }, { name: 'click', filter: { field: { key: 'x', type: 'number' as const }, op: 'gte' as const, value: 1 } }]) {
      const input: ArmQuery = { from: SWEEP_START, to: SWEEP_NOW, experimentId: 'exp-0', groupBy: [{ key: 'group', type: 'string' }], ...(hasEvent ? { hasEvent } : {}) };
      for (const bucket of [undefined, 60_000]) {
        const expected = db.run(baseline.arms(input, bucket).sql), actual = db.run(next.arms(input, bucket).sql);
        expect(expected.length).toBeGreaterThan(0);
        expect(actual).toHaveLength(expected.length);
        actual.forEach((row, i) => {
          expect(Object.keys(row)).toEqual(Object.keys(expected[i]!));
          for (const key of Object.keys(row)) {
            if (typeof row[key] === 'number' && typeof expected[i]![key] === 'number') expect(row[key]).toBeCloseTo(expected[i]![key] as number, 9);
            else expect(row[key]).toEqual(expected[i]![key]);
          }
        });
      }
    }
  } finally { db.close(); }
});
