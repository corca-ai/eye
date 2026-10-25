import { expect, it } from 'vitest';
import { attributionCTEs } from '../../src/analytics/attribution-sql.js';
import { exposureProjection } from '../../src/analytics/projections-sql.js';
import { attributionCTEs as referenceAttribution } from '../../benchmarks/analytics/reference-attribution.js';
import { exposureProjection as referenceProjection } from '../../benchmarks/analytics/reference-projections.js';
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

it.each(['observations', 'decisions'] as const)('preserves %s when source receipts are limited to the cohort start', table => {
  const db = database(queryStream(30));
  try {
    for (const [from, to] of [[now - 2 * day, now - day], [now - 12 * day, now - 2 * day], [now - day, now]] as const) {
      const args = [table, 'p', 'eye', "'site'", now - 60 * day, from, to, now, ''] as const;
      const query = (cte: string) => `WITH ${cte} SELECT * FROM p ORDER BY record_id`;
      expect(db.run(query(exposureProjection(...args)))).toEqual(db.run(query(referenceProjection(...args))));
    }
  } finally { db.close(); }
});
