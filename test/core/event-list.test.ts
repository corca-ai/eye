import { expect, it } from 'vitest';
import { database } from '../helpers/analytics-db.js';
import { BasinAnalytics } from '../../src/analytics/query.js';
import { AnalyticsSQL } from '../../src/analytics/sql.js';
import { rawRecords } from '../../src/analytics/raw.js';
import { exportRecords } from '../../src/analytics/export.js';
import type { EyeEvent } from '../../src/core/types.js';

const now = 1_800_000_000_000, from = now - 1000;
const env = { EYE_ANALYTICS_WAREHOUSE: `${'a'.repeat(32)}_eye-data`, EYE_ANALYTICS_TOKEN: 'test' };
const base = { subject: { cid: 'c', uid: 'u' }, occurredAt: from + 1 };

it('roundtrips compact track and signed goal payloads alongside legacy rows, including absent and empty attributes', async () => {
  const events: EyeEvent[] = [
    { ...base, kind: 'track', eventId: 'a', name: 'view' },
    { ...base, kind: 'track', eventId: 'b', name: 'click', attributes: {} },
    { ...base, kind: 'goal', eventId: 'c', goalId: 'refund', value: -12, attributes: { locale: '한국', nil: null } },
  ];
  const compact = events.flatMap(event => rawRecords({ siteId: 'site', receivedAt: now - 1, event }));
  const legacy = events.map((event, i) => ({ ...compact[i]!, schema_version: 1,
    record_id: `legacy-${event.eventId}`, payload_json: JSON.stringify({ ...event, eventId: `legacy-${event.eventId}`, processingStatus: 'accepted' }) }));
  const records = exportRecords([...compact, ...legacy].map(record => ({ record })));
  expect(records.filter(r => r.table_name === 'attribute_keys').every(r => r.schema_version === 1)).toBe(true);
  const db = database(records), api = new BasinAnalytics(env, 'site', db.request, () => now);
  try {
    const full = await api.events({ from, to: now });
    for (const event of events) expect(full.rows.find(r => r.recordId === event.eventId)?.payload).toEqual({ ...event, processingStatus: 'accepted' });
    const list = await api.eventList({ from, to: now });
    expect(list.rows.map(r => r.name)).toEqual(['view', 'click', 'refund', 'view', 'click', 'refund']);
    expect(list.rows.every(r => !('payload' in r) && !('subjectKey' in r))).toBe(true);
    expect(await api.goals({ from, to: now })).toMatchObject({ rows: [{ events: 2, totalValue: -24 }] });
  } finally { db.close(); }
});

it('filters after revision selection and preserves tied timestamps and receipt cutoff across light pages', async () => {
  const raw = (eventId: string, uid: string, receivedAt: number) => rawRecords({ siteId: 'site', receivedAt,
    event: { ...base, subject: { cid: 'c', uid }, eventId, kind: 'track', name: 'view', attributes: { project_id: 'p' } } })[0]!;
  const rows = [raw('a', 'u', now - 3), raw('a', 'other', now - 2), raw('b', 'u', now - 1), raw('c', 'u', now + 1)];
  const db = database(rows); let clock = now;
  const api = new BasinAnalytics(env, 'site', db.request, () => clock);
  const query = { from, to: now, uid: 'u', name: 'view', limit: 1,
    filter: { field: { key: 'project_id', type: 'string' as const }, op: 'eq' as const, value: 'p' } };
  try {
    const first = await api.eventList(query);
    expect(first.rows.map(r => r.recordId)).toEqual(['a']); expect(first.nextCursor).not.toBeNull();
    clock += 10;
    const second = await api.eventList({ ...query, cursor: first.nextCursor! });
    expect(second.rows.map(r => r.recordId)).toEqual(['b']); expect(second.nextCursor).toBeNull();
    expect(second.meta.receivedBefore).toBe(now);
    expect((await api.eventList({ ...query, uid: 'other' })).rows).toEqual([]);
    await expect(api.events({ ...query, cursor: first.nextCursor! })).rejects.toThrow('Cursor');
    await expect(api.eventList({ ...query, cid: 'different', cursor: first.nextCursor! })).rejects.toThrow('Cursor');
    const plan = new AnalyticsSQL('eye', 'site', clock).events(query, true);
    expect(db.run(plan.sql)[0]).not.toHaveProperty('payload_json');
  } finally { db.close(); }
});
