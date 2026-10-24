import { expect, it } from 'vitest';
import { anonymousLink, identitySegments } from '../../src/analytics/attribution-sql.js';
import { IdentityHistory } from '../../src/core/identity-history.js';
import { rawRecords } from '../../src/analytics/raw.js';
import { database } from '../helpers/analytics-db.js';
import type { IdentityEvent, TrackEvent } from '../../src/core/types.js';
it('SQL anonymous membership matches first-login segments across repeats, account switches and logout ties', () => {
  const at = 1_800_000_000_000;
  const boundary = (offset: number, eventId: string, uid?: string): IdentityEvent => ({
    kind: uid ? 'identify' : 'logout', eventId, occurredAt: at + offset, subject: { cid: 'browser', ...(uid ? { uid } : {}) },
  });
  const identities = [boundary(1, 'l0'), boundary(10, 'i0', 'alice'), boundary(12, 'i1', 'alice'),
    boundary(20, 'i2', 'bob'), boundary(30, 'l1'), boundary(35, 'l2'), boundary(40, 'i3', 'bob')];
  const points: [number, string][] = [[0, 't0'], [1, 'a'], [1, 'z'], [5, 't5'], [10, 'a0'], [10, 'z0'], [11, 't11'], [25, 't25'], [32, 't32'], [36, 't36'], [45, 't45']];
  const tracks: TrackEvent[] = points.map(([offset, eventId]) => ({ kind: 'track', eventId, occurredAt: at + offset, subject: { cid: 'browser' }, name: 'view' }));
  const history = new IdentityHistory(identities);
  const db = database([...identities, ...tracks].flatMap(event => rawRecords({ siteId: 'site', receivedAt: at + 100, event })));
  try {
    for (const uid of ['alice', 'bob']) {
      const expected = tracks.filter(event => history.matches(event, { eventId: 'last', occurredAt: at + 100, subject: { cid: 'other', uid } })).map(e => e.eventId).sort();
      const rows = db.run(`WITH links AS (SELECT * FROM eye.identity_links), ${identitySegments('links', 'segments')} SELECT r.record_id FROM eye.events r
WHERE json_get_str(r.payload_json, 'kind') = 'track' AND ${anonymousLink('r', `'${uid}'`, 'segments', String(at + 100))}`);
      expect(rows.map(r => r.record_id).sort()).toEqual(expected);
      // Observation/assignment IDs have a different namespace from event IDs;
      // an anonymous projection can coincide exactly with a login position.
      const exact = db.run(`WITH links AS (SELECT * FROM eye.identity_links), ${identitySegments('links', 'segments')},
r AS (SELECT 'browser' AS cid, NULL AS uid, ${at + 10} AS occurred_at, 'i0' AS record_id)
SELECT * FROM r WHERE ${anonymousLink('r', `'${uid}'`, 'segments', String(at + 100))}`);
      expect(exact).toEqual([]);
    }
  } finally { db.close(); }
});
