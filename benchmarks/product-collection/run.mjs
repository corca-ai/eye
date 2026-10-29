// Run against a built dist tree; all inputs are synthetic and no network is used.
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const dist = resolve(process.argv[2] ?? 'dist');
const load = file => import(pathToFileURL(resolve(dist, file)).href);
const { IncrementalLearning } = await load('runtime/incremental.js');
const { rawRecords } = await load('analytics/raw.js');
const { sendExportBatches, DictionaryCache } = await load('analytics/export.js');
const { AnalyticsSQL } = await load('analytics/sql.js');
const now = Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 1000;
const db = new DatabaseSync(':memory:');
const calls = [];
const sql = { exec(query, ...bindings) {
  calls.push(query); let rows = [];
  if (query.trimStart().startsWith('CREATE ')) db.exec(query); else rows = db.prepare(query).all(...bindings);
  return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
} };
const engine = new IncrementalLearning(sql);
const goals = Array.from({ length: 100 }, (_, i) => ({ kind: 'goal', eventId: `g${i}`, occurredAt: now,
  subject: { cid: `c${i}`, uid: `u${i}` }, goalId: 'writing_day', value: 500 }));
calls.length = 0;
assert(engine.accept(goals, now, () => true, goals.map(() => now)).accepted.every(Boolean));
assert.equal(db.prepare('SELECT events FROM hourly_goals').get().events, 100);
const learning = { sqlCalls: calls.length, ownerReads: calls.filter(q => q.startsWith('SELECT experiment_id, data FROM learning_last')).length };
const siteId = '00000000-0000-0000-0000-000000000001';
const subject = { cid: '00000000-0000-0000-0000-000000000002', uid: 'usr_00000000-0000-0000-0000-000000000003' };
const fixtures = [
  { kind: 'track', name: 'page_view', attributes: { page_type: 'workspace', ui_locale: 'ko', project_id: 'prj_00000000-0000-0000-0000-000000000004' } },
  { kind: 'goal', goalId: 'reference_added', value: 100, attributes: { project_id: 'prj_00000000-0000-0000-0000-000000000004', reference_id: 'ref_00000000-0000-0000-0000-000000000005', schema: 1, value_unit: 'KRW', value_effective_at: 0 } },
];
const wireBytes = fixtures.map((fixture, i) => ({ kind: fixture.kind, bytes: Buffer.byteLength(JSON.stringify(rawRecords({ siteId, receivedAt: now,
  event: { ...fixture, eventId: `00000000-0000-0000-0000-00000000000${i}`, occurredAt: now, subject } })[0])) }));
// Each row represents a separate message here. Runtime tests also cover packed
// siblings and dictionaries that cross a chunk boundary before acknowledgement.
const rows = Array.from({ length: 10000 }, (_, i) => ({ record: rawRecords({ siteId, receivedAt: now,
  event: { kind: 'track', name: 'page_view', eventId: `event_${i}`, occurredAt: now, subject, attributes: { page_type: 'workspace', ui_locale: 'ko' } } })[0] }));
let attempts = 0; const delivered = [], completed = new Set(), cache = new DictionaryCache();
try { await sendExportBatches(rows, async batch => {
  if (++attempts === 2) throw Error('simulated second-chunk failure');
  delivered.push(...batch.filter(r => r.table_name === 'events').map(r => r.record_id));
}, cache, acknowledged => acknowledged.forEach(row => completed.add(row))); } catch {}
await sendExportBatches(rows.filter(row => !completed.has(row)), async batch => delivered.push(...batch.filter(r => r.table_name === 'events').map(r => r.record_id)), cache);
assert.equal(new Set(delivered).size, rows.length);
const listPlan = new AnalyticsSQL('eye', siteId, now + 1).events({ from: now - 1000, to: now, limit: 50 }, true);
console.log(JSON.stringify({ runtime: process.version, learning, wireBytes,
  retry: { input: rows.length, delivered: delivered.length, unique: new Set(delivered).size },
  listProjectsFullPayload: /SELECT .*payload_json, ROW_NUMBER/s.test(listPlan.sql),
  limitations: 'Synthetic Node memory SQLite, JSON wire bytes and injected export failure; not Cloudflare CPU, compressed storage, query scan bytes or billing.' }, null, 2));
db.close();
