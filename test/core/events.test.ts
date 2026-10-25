import { describe, expect, it } from 'vitest';
import { database } from '../helpers/analytics-db.js';
import { analyticsRecord } from '../../src/analytics/records.js';
import { BasinAnalytics } from '../../src/analytics/query.js';
import { AnalyticsSQL } from '../../src/analytics/sql.js';
import { jobCacheIdentity, runJobQuery, validateJobRequest } from '../../src/analytics/job-query.js';

const now = 1_800_000_000_000, from = now - 100_000, to = now - 1000;
const env = { EYE_ANALYTICS_WAREHOUSE: `${'a'.repeat(32)}_eye-data`, EYE_ANALYTICS_TOKEN: 'secret' };
const event = (id: string, at = from + 1, receivedAt = now - 100) => analyticsRecord(
  { siteId: 'site', subjectKey: 'u', cid: 'browser', uid: 'user' }, 'events', id, 1, at, receivedAt,
  { kind: 'track', name: 'created' }, { status: 'accepted' }, { project_id: 'project' },
);

describe('global event pages', () => {
  it('deduplicates events, isolates sites, filters typed attributes, and freezes the receive bound across pages', async () => {
    const first = event('a'), second = event('b'), late = event('late', from + 2, now + 1);
    const db = database([first, first, second, late, { ...event('other'), site_id: 'other' },
      { ...event('goal'), goal_id: 'g', value: -200, payload_json: '{"kind":"goal"}' },
      { ...event('wrong-project'), attributes_json: '{"project_id":"other"}' }]);
    try {
      let clock = now;
      const api = new BasinAnalytics(env, 'site', db.request, () => clock);
      const query = { from, to, name: 'created', uid: 'user', cid: 'browser', limit: 1,
        filter: { field: { key: 'project_id', type: 'string' as const }, op: 'eq' as const, value: 'project' } };
      const one = await api.events(query);
      expect(one.rows.map(r => r.recordId)).toEqual(['a']);
      expect(one.meta.truncated).toBe(true);
      expect(one.nextCursor).not.toBeNull();
      clock += 10;
      const two = await api.events({ ...query, cursor: one.nextCursor! });
      expect(two.rows.map(r => r.recordId)).toEqual(['b']);
      expect(two.nextCursor).toBeNull();
      expect(two.meta.receivedBefore).toBe(now);
      await expect(api.events({ ...query, uid: 'different', cursor: one.nextCursor! })).rejects.toThrow('Cursor');
      expect((await api.events({ from, to, goalId: 'g' })).rows.map(r => r.value)).toEqual([-200]);
      expect((await api.events({ from, to, uid: 'missing' })).rows).toEqual([]);
      const request = { kind: 'events' as const, query };
      expect(validateJobRequest('site', request, clock)).toContain('events');
      expect((await runJobQuery(api, request)).kind).toBe('events');
    } finally { db.close(); }
  });

  it('keeps large escaped filters pageable and preserves cursor-compatible job identity', async () => {
    const value = "'".repeat(8000);
    const filter = { and: [
      { field: { key: 'a', type: 'string' as const }, op: 'eq' as const, value },
      { field: { key: 'b', type: 'string' as const }, op: 'eq' as const, value },
    ] };
    const request = { kind: 'events' as const, query: { from, to, filter, limit: 1 } };
    const reversed = { ...request, query: { ...request.query, filter: { and: [...filter.and].reverse() } } };
    expect(jobCacheIdentity(validateJobRequest('site', request, now)))
      .not.toBe(jobCacheIdentity(validateJobRequest('site', reversed, now)));
    const db = database(['a', 'b'].map(id => ({ ...event(id), attributes_json: JSON.stringify({ a: value, b: value }) })));
    try {
      const api = new BasinAnalytics(env, 'site', db.request, () => now);
      const page = await api.events(request.query);
      expect(page.nextCursor!.length).toBeLessThan(1000);
      const next = await api.events({ ...request.query, cursor: page.nextCursor! });
      expect(next.rows.map(row => row.recordId)).toEqual(['b']);
      expect(next.nextCursor).toBeNull();
    } finally { db.close(); }
  });

  it('rejects cross-kind cursors, invalid IDs, overlarge limits, and expired ranges', () => {
    const sql = new AnalyticsSQL('eye', 'site', now);
    expect(() => sql.events({ from, to, name: '' })).toThrow();
    expect(() => sql.events({ from: 0, to })).toThrow('60 days');
    expect(() => sql.events({ from, to, limit: 1001 })).toThrow('limit');
    expect(() => sql.events({ from, to, cursor: JSON.stringify({ fingerprint: 'other', receivedBefore: now,
      at: from, table: 'observations', id: 'id' }) })).toThrow('Cursor');
  });
});
