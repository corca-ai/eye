import { database } from '../helpers/analytics-db.js';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { analyticsRecord } from '../../src/analytics/records.js';
import type { AnalyticsRecord } from '../../src/analytics/records.js';
import { AnalyticsSQL, compileFilter, TABLES } from '../../src/analytics/sql.js';
import { BasinAnalytics } from '../../src/analytics/query.js';
import { exportBatches, exportRecords, EXPORT_BATCH_BYTES, validateExport } from '../../src/analytics/export.js';
import type { Filter, TimelineQuery } from '../../src/analytics/types.js';

const now = 1_800_000_000_000, from = now - 100_000, to = now - 1000;
const config = { EYE_ANALYTICS_WAREHOUSE: `${'a'.repeat(32)}_eye-data`, EYE_ANALYTICS_TOKEN: 'test-token' };
const sql = () => new AnalyticsSQL('eye', 'site', now);
function row(table: AnalyticsRecord['table_name'], id: string, overrides: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return { ...analyticsRecord({ siteId: 'site', subjectKey: 'subject', cid: 'browser' }, table, id, 1, from + 100, now - 100, {}), ...overrides };
}
function observation(id: string, status: string, value: number, overrides: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return row('observations', id, { observation_id: id, experiment_id: 'exp', arm_id: 'a', status, value,
    payload_json: JSON.stringify({ generation: 1, endAt: from + 10_100 }), ...overrides });
}
/** Executes the generated relational SQL, with only Basin's documented JSON UDFs adapted.
 * This checks query semantics locally, not Basin's planner, limits, or remote performance. */

describe('analytics query semantics', () => {


  it('counts each accepted original signed goal once and buckets in UTC milliseconds', async () => {
    const goal = row('events', 'purchase', { goal_id: 'purchase', value: 20, status: 'accepted', payload_json: '{"kind":"goal"}' });
    const db = database([goal, goal,
      row('events', 'refund', { goal_id: 'refund', value: -8, status: 'accepted', payload_json: '{"kind":"goal"}' }),
      row('events', 'ignored', { goal_id: 'purchase', value: 500, status: 'ignored', payload_json: '{"kind":"goal"}' }),
      row('credits', 'derived', { goal_id: 'purchase', value: 20, status: 'eligible' }),
    ]);
    try {
      const client = new BasinAnalytics(config, 'site', db.request, () => now);
      expect((await client.goals({ from, to })).rows.map(r => [r.goalId, r.events, r.totalValue])).toEqual([['purchase', 1, 20], ['refund', 1, -8]]);
      expect((await client.series({ from, to, bucketMs: 60_000 })).rows[0]?.bucketStart).toBe(Math.floor((from + 100) / 60_000) * 60_000);
    } finally { db.close(); }
  });

  it('supports typed arbitrary attribute filters, literal keys, null versus missing, and safely quoted values', () => {
    const attrs = { "key'.": "x'); DROP TABLE events; --", n: 3, nil: null };
    const db = database([row('events', 'one', { attributes_json: JSON.stringify(attrs) }), row('events', 'two', { attributes_json: '{"n":"3"}' })]);
    try {
      const filter: Filter = { and: [
        { field: { key: "key'.", type: 'string' }, op: 'eq', value: attrs["key'."] },
        { field: { key: 'n', type: 'number' }, op: 'gte', value: 3 },
        { field: { key: 'nil', type: 'string' }, op: 'eq', value: null },
        { field: { key: 'absent', type: 'boolean' }, op: 'missing' },
      ] };
      const result = db.run(sql().attributeValues({ from, to, field: { key: 'n', type: 'number' }, filter }).sql);
      expect(result[0]?.events).toBe(1); expect(result[0]?.attribute_value).toBe(3);
      expect(db.run(sql().attributeValues({ from, to, field: { key: 'n', type: 'number' } }).sql)).toHaveLength(2);
      expect(() => compileFilter({ field: { key: 'n', type: 'number' }, op: 'eq', value: '3' }, 'e')).toThrow('declared attribute type');
    } finally { db.close(); }
  });
  it('rejects invalid ranges, unsafe namespaces, oversized queries, and recursive filter input', () => {
    expect(() => new AnalyticsSQL('eye;drop', 'site')).toThrow('namespace');
    expect(() => sql().goals({ from: 0, to })).toThrow('60 days');
    expect(() => sql().goals({ from, to, limit: 1001 })).toThrow('limit');
    expect(() => sql().series({ from, to, bucketMs: 0 })).toThrow('bucketMs');
    const recursive: { not?: unknown } = {}; recursive.not = recursive;
    expect(() => compileFilter(recursive, 'e')).toThrow('too complex');
  });
});

describe('Basin boundary', () => {
  it('uses the documented endpoint and validated response contract without exposing its secret', async () => {
    const request: typeof fetch = async (url, init) => {
      expect(String(url)).toBe(`https://api.sql.cloudflarestorage.com/api/v1/accounts/${'a'.repeat(32)}/basin-sql/query/eye-data`);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
      expect(init?.redirect).toBe('manual');
      expect(JSON.parse(String(init?.body)).warehouse).toBe(config.EYE_ANALYTICS_WAREHOUSE);
      return Response.json({ success: true, result: { rows: [], metrics: { bytes_scanned: 55 } } });
    };
    const result = await new BasinAnalytics(config, 'site', request, () => now).goals({ from, to });
    expect(result.meta).toEqual({ consistency: 'eventual', receivedBefore: now, queriedAt: now, truncated: false, bytesScanned: 55 });
    expect(JSON.stringify(result)).not.toContain(config.EYE_ANALYTICS_TOKEN);
    await expect(new BasinAnalytics(config, 'site', async () => new Response('sensitive text', { status: 400 }), () => now).goals({ from, to })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(new BasinAnalytics(config, 'site', async () => Response.json({ success: true, result: { rows: [{ goal_id: 'g', events: 1, total_value: null, latest_received_at: now }] } }), () => now).goals({ from, to })).rejects.toMatchObject({ code: 'numeric_range' });
  });
  it('bounds encoded UTF-8 export batches and rejects nonfinite data before Stream acceptance', () => {
    const records = Array.from({ length: 60 }, (_, i) => ({ record: row('events', String(i), { payload_json: JSON.stringify({ text: '한'.repeat(50_000) }) }) }));
    const batches = [...exportBatches(records)];
    expect(batches.length).toBeGreaterThan(1); expect(batches.flat()).toEqual(records);
    for (const batch of batches) expect(new TextEncoder().encode(JSON.stringify(batch.map(r => r.record))).byteLength).toBeLessThanOrEqual(EXPORT_BATCH_BYTES);
    expect(() => validateExport(row('credits', 'bad', { value: Infinity }))).toThrow('analytics value');
  });
});






it('discovers a daily attribute in an hourly query even when the earlier duplicate won export deduplication', async () => {
  const day = Math.floor(now / 86_400_000) * 86_400_000 - 86_400_000;
  const records = exportRecords([9, 10].map(hour => ({ record: row('events', `hour-${hour}`, {
    occurred_at: day + hour * 3_600_000, attributes_json: '{"plan":"paid"}',
  }) })));
  expect(records.filter(r => r.table_name === 'attribute_keys')).toHaveLength(1);
  const db = database(records);
  try {
    const api = new BasinAnalytics(config, 'site', db.request, () => now);
    const result = await api.attributeKeys({ from: day + 10 * 3_600_000, to: day + 11 * 3_600_000 });
    expect(result.rows[0]).toMatchObject({ key: 'plan', type: 'string', source: 'event' });
    expect(result.coverage).toEqual({ basis: 'utc_day', from: day, to: day + 86_400_000 });
  } finally { db.close(); }
});

describe('Workers fetch invocation', () => {
  it('calls the default fetch with its platform global receiver', async () => {
    const nativeStyleFetch: typeof fetch = async function (this: unknown, _input, init) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      if (init?.redirect === 'error') throw new TypeError('Invalid redirect value');
      expect(init?.redirect).toBe('manual');
      return Response.json({ success: true, result: { rows: [], metrics: {} } });
    };
    vi.stubGlobal('fetch', nativeStyleFetch);
    try {
      const client = new BasinAnalytics(config, 'site', undefined, () => now);
      expect((await client.goals({ from, to })).rows).toEqual([]);
    } finally { vi.unstubAllGlobals(); }
  });
});

it('summarizes frozen observations without raw queries, deduplicates retries and safely sums signed rewards', async () => {
  const rows = [1e308, 1e308, -1e308, -1e308, 0].map((value, i) => observation(`closed-${i}`, 'complete', value, { revision: 2 }));
  const db = database([...rows, rows[0]!, observation('pending', 'pending', 999)]);
  try {
    const query = sql().learning({ from, to });
    expect(query.sql).not.toContain('.events'); expect(query.sql).not.toContain('.identity_links');
    const report = await new BasinAnalytics(config, 'site', db.request, () => now).learning({ from, to });
    expect(report.rewardBasis).toBe('closed_learning');
    expect(report.rows[0]).toMatchObject({ completed: 5, learningValue: 0, meanValue: 0 });
  } finally { db.close(); }
});
