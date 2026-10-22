import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { analyticsRecord } from '../../src/analytics/records.js';
import type { AnalyticsRecord } from '../../src/analytics/records.js';
import { AnalyticsSQL, compileFilter, TABLES } from '../../src/analytics/sql.js';
import { BasinAnalytics } from '../../src/analytics/query.js';
import { exportBatches, EXPORT_BATCH_BYTES, validateExport } from '../../src/analytics/export.js';
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
function database(records: AnalyticsRecord[]) {
  const db = new DatabaseSync(':memory:');
  db.exec("ATTACH DATABASE ':memory:' AS eye");
  const example = row('events', 'example');
  for (const table of TABLES) {
    db.exec(`CREATE TABLE eye.${table} (${Object.keys(example).map(key => `"${key}" ${['schema_version', 'revision', 'occurred_at', 'received_at', 'value'].includes(key) ? 'REAL' : 'TEXT'}`).join(',')})`);
  }
  for (const record of records) db.prepare(`INSERT INTO eye.${record.table_name} VALUES (${Object.keys(example).map(() => '?').join(',')})`).run(...Object.values(record));
  for (const [name, kind] of [['json_get_str', 'string'], ['json_get_float', 'number'], ['json_get_int', 'number'], ['json_get_bool', 'boolean'], ['json_get_json', 'json'], ['json_contains', 'exists']] as const) {
    db.function(name, (json, key) => {
      const obj: Record<string, unknown> = JSON.parse(String(json)), value = obj[String(key)];
      if (kind === 'exists') return Object.hasOwn(obj, String(key)) ? 1 : 0;
      if (kind === 'json') return value === undefined ? null : JSON.stringify(value);
      return typeof value !== kind ? null : typeof value === 'boolean' ? Number(value) : String(value) === 'undefined' ? null : typeof value === 'number' || typeof value === 'string' ? value : null;
    });
  }
  const run = (query: string) => db.prepare(query).all().map(r => ({ ...r }));
  const request: typeof fetch = async (_url, init) => {
    const body: { query: string } = JSON.parse(String(init?.body));
    return Response.json({ success: true, result: { rows: run(body.query), metrics: { bytes_scanned: 128 } } });
  };
  return { run, request, close: () => db.close() };
}

describe('analytics query semantics', () => {
  it('deduplicates revisions before status filtering and keeps zero observations in a goal-specific denominator', async () => {
    const zero = observation('zero', 'complete', 0), paid = observation('paid', 'complete', 12);
    const db = database([zero, zero, paid, observation('cancelled', 'complete', 99), observation('cancelled', 'interrupted', 99, { revision: 2 }),
      observation('waiting', 'pending', 10),
      row('credits', 'credit', { experiment_id: 'exp', observation_id: 'paid', goal_id: 'purchase', status: 'eligible', value: 8 }),
      row('credits', 'credit', { revision: 2, experiment_id: 'exp', observation_id: 'paid', goal_id: 'purchase', status: 'eligible', value: 6 }),
      row('credits', 'outside', { experiment_id: 'exp', observation_id: 'zero', goal_id: 'purchase', status: 'outside_observation', value: 100 }),
      observation('other-site', 'complete', 999, { site_id: 'another' }),
    ]);
    try {
      const report = await new BasinAnalytics(config, 'site', db.request, () => now).arms({ from, to, experimentId: 'exp', goalId: 'purchase' });
      expect(report.cohortBasis).toBe('observation_start');
      expect(report.rows).toEqual([{ armId: 'a', generation: 1, observationWindowMs: 10_000, groups: [], completed: 2, interrupted: 1, pending: 1, subjects: 1, totalValue: 6, meanValue: 3, latestReceivedAt: now - 100 }]);
    } finally { db.close(); }
  });
  it('uses observation-start attributes and semijoins repeated events across uid adoption without inflating the denominator', () => {
    const db = database([
      observation('zero', 'complete', 0, { subject_key: 'cid-before', state_key: 'same-home', attributes_json: '{"country":"KR"}' }),
      observation('other', 'complete', 20, { state_key: 'other-home', attributes_json: '{"country":"JP"}' }),
      ...['one', 'two'].map(id => row('events', id, { subject_key: 'uid-after', state_key: 'same-home', uid: 'alice', payload_json: '{"kind":"track","name":"read"}' })),
    ]);
    try {
      const result = db.run(sql().arms({ from, to, experimentId: 'exp', groupBy: [{ key: 'country', type: 'string' }], hasEvent: { name: 'read' } }).sql);
      expect(result).toHaveLength(1); expect(result[0]?.completed).toBe(1); expect(result[0]?.group_0).toBe('KR');
    } finally { db.close(); }
  });
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
  it('uses current identity intervals and cursor tie breakers without extending uid identity past logout', async () => {
    const link = row('identity_links', 'login', { occurred_at: from - 10_000, uid: 'alice', status: 'active', payload_json: JSON.stringify({ linkedUntil: from + 400 }) });
    const records = [link, { ...link, revision: 2, payload_json: JSON.stringify({ linkedUntil: from + 200 }) },
      row('events', 'a', { occurred_at: from + 100 }), row('events', 'b', { occurred_at: from + 100 }),
      row('events', 'unrelated', { occurred_at: from + 300 }),
      row('events', 'other-account', { occurred_at: from + 100, uid: 'bob' }),
      row('decisions', 'c', { occurred_at: from + 100, cid: 'second-device', uid: 'alice' }),
    ];
    const db = database(records);
    try {
      const client = new BasinAnalytics(config, 'site', db.request, () => now);
      const query: TimelineQuery = { from, to, subject: { uid: 'alice' }, limit: 2 };
      const first = await client.timeline(query);
      expect(first.rows.map(r => r.recordId)).toEqual(['c', 'a']); expect(first.nextCursor).not.toBeNull();
      const second = await client.timeline({ ...query, cursor: first.nextCursor! });
      expect(second.rows.map(r => r.recordId)).toEqual(['b']); expect(second.nextCursor).toBeNull();
      await expect(client.timeline({ ...query, subject: { uid: 'bob' }, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'invalid_input' });
      expect((await client.timeline({ ...query, includeLinked: false })).rows.map(r => r.recordId)).toEqual(['c']);
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
      expect(init?.redirect).toBe('error');
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
