import { expect, it } from 'vitest';
import { attributionCTEs } from '../../src/analytics/attribution-sql.js';
import { AnalyticsSQL } from '../../src/analytics/sql.js';
import { attributionCTEs as referenceAttribution } from '../../benchmarks/analytics/reference-temporal-attribution.js';
import { AnalyticsSQL as ReferenceSQL } from '../../benchmarks/analytics/reference-scoped-sql.js';
import { rawRecords } from '../../src/analytics/raw.js';
import { database } from '../helpers/analytics-db.js';
import { hotSubjectStream, temporalExposure as exposure, TEMPORAL_NOW as now, TEMPORAL_START as start } from '../helpers/temporal-stream.js';
import { queryStream, QUERY_NOW, QUERY_DAY } from '../helpers/query-stream.js';
import type { EyeEvent } from '../../src/core/types.js';

const creditQuery = (ctes: string[]) => `WITH ${ctes.join(',')} SELECT * FROM credits_latest ORDER BY record_id`;
it('reduces hot-UID candidates to one per goal and experiment, preserving every credit', () => {
  const db = database(hotSubjectStream(160));
  try {
    const args = ['eye', "'site'", now - 60 * 86_400_000, start, now, now] as const;
    const old = referenceAttribution(...args), next = attributionCTEs(...args);
    expect(db.run(creditQuery(next))).toEqual(db.run(creditQuery(old)));
    const count = (ctes: string[]) => db.run(`WITH ${ctes.join(',')} SELECT COUNT(*) AS n FROM ac_matches`)[0]!.n;
    expect(count(old)).toBe(12880); expect(count(next)).toBe(160);
  } finally { db.close(); }
});

it('preserves same-time ordering, cross-device UID, anonymous competition and expired latest touches', () => {
  const uid = { cid: 'device-a', uid: 'u' }, other = { cid: 'device-b', uid: 'u' };
  const events: EyeEvent[] = [
    exposure('00-old', start, uid), exposure('10-direct', start + 10, other, 'exp', 1),
    exposure('15-anon', start + 10, { cid: 'anon' }),
    { kind: 'identify', eventId: '20-login', occurredAt: start + 10, subject: { cid: 'anon', uid: 'u' } },
    exposure('30-other', start + 10, uid, 'other'),
    ...['05-goal', '17-goal', '25-goal', '35-goal'].map((eventId): EyeEvent => ({
      kind: 'goal', eventId, occurredAt: start + 10, subject: other, goalId: 'pay', value: 100,
    })),
    exposure('40-latest-short', start + 20, uid, 'exp', 1),
    { kind: 'goal', eventId: '50-expired', occurredAt: start + 30, subject: uid, goalId: 'pay', value: -100 },
    exposure('😀', start + 40, uid), exposure('\uE000', start + 40, other),
    { kind: 'goal', eventId: '🧪', occurredAt: start + 40, subject: uid, goalId: 'pay', value: 10 },
  ];
  const rows = events.flatMap(event => rawRecords({ siteId: 'site', receivedAt: now - 1, event }));
  const db = database([...rows, ...rows.map(row => ({ ...row, received_at: now }))]);
  try {
    const args = ['eye', "'site'", now - 60 * 86_400_000, start, now, now] as const;
    expect(db.run(creditQuery(attributionCTEs(...args)))).toEqual(db.run(creditQuery(referenceAttribution(...args))));
    const next = new AnalyticsSQL('eye', 'site', now), old = new ReferenceSQL('eye', 'site', now);
    for (const subject of [{ cid: 'device-a' }, { cid: 'device-b' }, { cid: 'anon' }, { uid: 'u' }]) for (const includeLinked of [false, true]) {
      const query = { from: start - 1, to: now, subject, includeLinked, limit: 1000 };
      expect(db.run(next.timeline(query).sql)).toEqual(db.run(old.timeline(query).sql));
    }
  } finally { db.close(); }
});

it.each([false, true])('matches whole-site timeline results after scoping, including linked identities and pagination (%s)', includeLinked => {
  const db = database(queryStream(30, 7));
  const next = new AnalyticsSQL('eye', 'site', QUERY_NOW), old = new ReferenceSQL('eye', 'site', QUERY_NOW);
  try {
    for (const subject of [{ cid: 'c-7-0' }, { cid: 'c-7-1' }, { uid: 'u-7-0' }, { uid: 'u-7-1' }, { uid: 'next-u-7-1' }, { uid: 'missing' }]) {
      const query = { from: QUERY_NOW - 3 * QUERY_DAY, to: QUERY_NOW, subject, includeLinked, limit: 3 };
      const first = db.run(next.timeline(query).sql), expected = db.run(old.timeline(query).sql);
      expect(first).toEqual(expected);
      const last = first[1];
      if (last) {
        const plan = next.timeline(query);
        const cursor = JSON.stringify({ fingerprint: plan.fingerprint, receivedBefore: plan.receivedBefore,
          at: last.occurred_at, table: last.table_name, id: last.record_id });
        expect(db.run(next.timeline({ ...query, cursor }).sql)).toEqual(db.run(old.timeline({ ...query, cursor }).sql));
      }
    }
  } finally { db.close(); }
});

it('preserves arm reports, competing experiments and hasEvent evidence with UID intervals', () => {
  const rows = queryStream(24, 7), db = database(rows);
  const next = new AnalyticsSQL('eye', 'site', QUERY_NOW), old = new ReferenceSQL('eye', 'site', QUERY_NOW);
  try {
    for (const experimentId of ['exp', 'other', 'absent']) for (const hasEvent of [undefined, { name: 'view' }]) {
      const query = { from: QUERY_NOW - 3 * QUERY_DAY, to: QUERY_NOW, experimentId,
        ...(hasEvent ? { hasEvent } : {}), groupBy: [{ key: 'locale', type: 'string' as const }] };
      expect(db.run(next.arms(query).sql)).toEqual(db.run(old.arms(query).sql));
      expect(db.run(next.arms(query, QUERY_DAY).sql)).toEqual(db.run(old.arms(query, QUERY_DAY).sql));
    }
  } finally { db.close(); }
});

it('keeps scoped work stable when unrelated users are added', () => {
  const counts = [];
  for (const unrelated of [0, 40]) {
    const db = database(hotSubjectStream(30, unrelated));
    try {
      const ctes = attributionCTEs('eye', "'site'", now - 60 * 86_400_000, start, now, now,
        { key: 'uid', value: "'u-0'", includeLinked: false });
      counts.push(db.run(`WITH ${ctes.join(',')} SELECT (SELECT COUNT(*) FROM ac_goals) AS goals,
(SELECT COUNT(*) FROM ac_exposures) AS exposures,(SELECT COUNT(*) FROM ac_matches) AS candidates`)[0]);
    } finally { db.close(); }
  }
  expect(counts).toEqual([{ goals: 30, exposures: 30, candidates: 30 }, { goals: 30, exposures: 30, candidates: 30 }]);
});
