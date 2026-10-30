import { expect, it } from 'vitest';
import { database } from '../helpers/analytics-db.js';
import { analyticsRecord } from '../../src/analytics/records.js';
import { AnalyticsSQL } from '../../src/analytics/sql.js';
import { BasinAnalytics } from '../../src/analytics/query.js';
import { EventSeriesCache } from '../../src/analytics/event-series-cache.js';

const now = 1_800_000_000_000, from = now - 100_000, to = now - 1000;
const config = { EYE_ANALYTICS_WAREHOUSE: `${'a'.repeat(32)}_eye-data`, EYE_ANALYTICS_TOKEN: 'test-token' };
it('counts the whole filtered interval with list-compatible deduplication, not just the first page', async () => {
  const records = Array.from({ length: 130 }, (_, i) => analyticsRecord({ siteId: 'site', subjectKey: 'c', cid: 'c', uid: 'u' },
    'events', `id-${i}`, 1, from + i * 500, now - 100, { kind: 'track', name: i % 2 ? 'edit' : 'view' },
    {}, { project_id: i < 120 ? 'project-a' : 'project-b' }));
  const changed = { ...records[0]!, revision: 2, attributes_json: '{"project_id":"project-b"}' };
  const db = database([...records, records[1]!, changed, { ...records[2]!, site_id: 'other-site' }]);
  try {
    const api = new BasinAnalytics(config, 'site', db.request, () => now);
    const filter = { field: { key: 'project_id', type: 'string' as const }, op: 'eq' as const, value: 'project-a' };
    const query = { from, to, uid: 'u', cid: 'c', filter };
    expect((await api.eventList({ ...query, limit: 50 })).rows).toHaveLength(50);
    const page = await api.eventSeries({ ...query, bucketMs: 60_000 });
    expect(page.rows.reduce((n, r) => n + r.events, 0)).toBe(119);
    expect(page.rows.every(r => r.bucketStart % 60_000 === 0)).toBe(true);
    expect((await api.eventSeries({ ...query, name: 'edit', bucketMs: 60_000 })).rows.reduce((n, r) => n + r.events, 0)).toBe(60);
    expect((await api.eventSeries({ ...query, goalId: 'none', bucketMs: 60_000 })).rows).toEqual([]);
    expect(page.meta.bytesScanned).toBe(128);
    const plan = new AnalyticsSQL('eye', 'site', now);
    expect(() => plan.eventSeries({ ...query, bucketMs: 0 })).toThrow('bucketMs');
    expect(() => plan.eventSeries({ ...query, bucketMs: 1 })).toThrow('full interval');
    expect(() => plan.eventSeries({ ...query, bucketMs: 60_000, cursor: 'x' } as never)).toThrow('cursors');
    // The projected event payload is only needed for an explicit name filter.
    expect(plan.eventSeries({ from, to, bucketMs: 60_000 }).sql).not.toContain('payload_json');
    expect(plan.eventSeries({ from, to, bucketMs: 60_000 }).sql).not.toContain('attributes_json');
  } finally { db.close(); }
});

it('shares concurrent work and completed snapshots, expires them and retries failures without caller mutation', async () => {
  let now = 100, calls = 0;
  const cache = new EventSeriesCache(() => now);
  const load = async () => { calls++; await Promise.resolve(); return { rows: [{ bucketStart: 0, events: 2, latestReceivedAt: 99 }],
    meta: { queriedAt: 100, receivedBefore: 100, consistency: 'eventual' as const, truncated: false,
      bytesScanned: 123, cacheHit: false, cacheExpiresAt: 100 } }; };
  const [a, b] = await Promise.all([cache.read('q', load), cache.read('q', load)]);
  expect(calls).toBe(1); expect(a.meta.cacheHit).toBe(false); expect(b.meta.cacheHit).toBe(true);
  a.rows[0]!.events = 100;
  expect((await cache.read('q', load)).rows[0]!.events).toBe(2);
  now = 120_100;
  expect((await cache.read('q', load)).meta.cacheHit).toBe(false); expect(calls).toBe(2);
  await expect(cache.read('failed', async () => { throw new Error('temporary'); })).rejects.toThrow('temporary');
  expect((await cache.read('failed', load)).meta.cacheHit).toBe(false);
  for (let i = 0; i < 65; i++) await cache.read(`query-${i}`, load);
  expect((await cache.read('q', load)).meta.cacheHit).toBe(false);
});

it('bounds distinct in-flight scans and releases failed slots for retry', async () => {
  const cache = new EventSeriesCache();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const work = Array.from({ length: 16 }, (_, i) => cache.read(String(i), async () => {
    await blocked;
    throw new Error('cancelled scan');
  }).catch(() => undefined));
  await expect(cache.read('overflow', async () => { throw new Error('must not run'); })).rejects.toThrow('Too many');
  release(); await Promise.all(work);
  await expect(cache.read('overflow', async () => { throw new Error('retry reached backend'); })).rejects.toThrow('retry reached backend');
});
