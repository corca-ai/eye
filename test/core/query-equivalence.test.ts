import { expect, it } from 'vitest';
import { attributionCTEs } from '../../src/analytics/attribution-sql.js';
import { attributionCTEs as referenceAttribution } from '../../benchmarks/analytics/reference-attribution.js';
import { database } from '../helpers/analytics-db.js';
import { queryStream, QUERY_NOW as now, QUERY_DAY as day } from '../helpers/query-stream.js';

it('preserves every credit with UID/cid/login ownership, ties, retries, long/short horizons and competing experiments', () => {
  const db = database(queryStream(24, 7));
  try {
    const args = ['eye', "'site'", now - 60 * day, now - 2 * day, now, now] as const;
    const query = (ctes: string[]) => `WITH ${ctes.join(',')} SELECT * FROM credits_latest ORDER BY record_id`;
    const expected = db.run(query(referenceAttribution(...args)));
    expect(expected.length).toBeGreaterThan(0);
    expect(db.run(query(attributionCTEs(...args)))).toEqual(expected);
  } finally { db.close(); }
}, 60_000);
