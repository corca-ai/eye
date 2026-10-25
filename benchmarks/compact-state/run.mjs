// npm run build && node benchmarks/compact-state/run.mjs
// --module=/absolute/path/to/old/dist/runtime/incremental.js measures an earlier learner.
// Local SQLite and JSON byte counts only, not Cloudflare billing or sustained throughput.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { settings } from '../../dist/core/validation.js';
import { compareEvents } from '../../dist/core/attribution.js';
import { rawRecords } from '../../dist/analytics/raw.js';
import { DictionaryCache, exportBatches, sendExportBatches } from '../../dist/analytics/export.js';
const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const modulePath = resolve(options.module ?? 'dist/runtime/incremental.js');
const { IncrementalLearning } = await import(pathToFileURL(modulePath).href);
const count = Number(options.events ?? 10000), repeats = Number(options.repeats ?? 5), H = 3_600_000;
assert.ok(Number.isSafeInteger(count) && count >= 20 && count % 20 === 0 && Number.isSafeInteger(repeats) && repeats > 0);
const config = settings({ minHoldMs: 0, observationWindowMs: 10000, allowedLatenessMs: 10, attributionHalfLifeMs: 1000, attributionWindowMs: 10000 });
const events = [];
for (let i = 0; i < count / 20; i++) {
  const subject = { cid: 'c' + i, uid: 'u' + i };
  events.push({ kind: 'identify', eventId: 'login-' + i, occurredAt: 0, subject });
  for (const experimentId of ['e', 'f']) {
    const assignment = { assignmentId: experimentId + i, experimentId, armId: i % 2 ? 'b' : 'a', generation: 1, assignedAt: 10, policyRevision: 1, probability: .5, settings: config };
    for (let j = 0; j < 4; j++) events.push({ kind: 'exposure', eventId: experimentId + i + '-' + j, occurredAt: 10 + j * 1000,
      subject, assignment, sample: { sampleId: experimentId + i, startAt: 10 }, attributionWindowMs: 10000 });
  }
  for (let j = 0; j < 2; j++) events.push({ kind: 'goal', eventId: 'g' + i + '-' + j, occurredAt: 4000 + j * 3000, subject, goalId: 'pay', value: i % 3 ? 100 : -20 });
  for (let j = 0; j < 9; j++) events.push({ kind: 'track', eventId: 't' + i + '-' + j, occurredAt: j * 900, subject, name: 'view' });
}
assert.equal(events.length, count);
const relevant = events.filter(e => e.kind !== 'track').sort(compareEvents);
const received = relevant.flatMap((e, i) => i % 101 === 0 ? [e, e] : [e]);
function run(enabled) {
  const db = new DatabaseSync(':memory:');
  let calls = 0;
  const sql = { exec(query, ...bindings) {
    calls++; let rows;
    if (query.trimStart().startsWith('CREATE ')) { db.exec(query); rows = []; } else rows = db.prepare(query).all(...bindings);
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  const engine = new IncrementalLearning(sql);
  if (enabled) engine.summaries.configure({ goalIds: ['pay'], experimentIds: ['e', 'f'] }, 0);
  calls = 0;
  const priorChanges = db.prepare('SELECT total_changes() AS n').get().n;
  const start = performance.now();
  for (let i = 0; i < received.length; i += 100) {
    const part = received.slice(i, i + 100);
    db.exec('BEGIN'); engine.accept(part, Math.max(...part.map(e => e.occurredAt))); db.exec('COMMIT');
  }
  const lastJsonBytes = db.prepare('SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) AS n FROM learning_last').get().n;
  const seenRows = db.prepare('SELECT COUNT(*) AS n FROM learning_seen').get().n;
  for (;;) { db.exec('BEGIN'); const n = engine.close('site', H); db.exec('COMMIT'); if (!n) break; }
  const elapsedMs = performance.now() - start, sqlCalls = calls;
  const rowChanges = db.prepare('SELECT total_changes() AS n').get().n - priorChanges;
  const observations = [];
  for (;;) {
    const outputs = engine.outputs(); if (!outputs.length) break;
    for (const { output } of outputs) for (const r of output.records) observations.push([r.record_id, r.value]);
    engine.acknowledge(outputs.map(o => o.id));
  }
  const rewardDigest = createHash('sha256').update(JSON.stringify(observations.sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  let summary = null;
  if (enabled) {
    const buckets = db.prepare('SELECT COUNT(*) AS n FROM summary_buckets').get().n;
    const started = performance.now();
    for (let i = 0; i < 100; i++) {
      const q = engine.summaries.query({ kind: 'learning', experimentId: 'e', from: 0, to: H }, H);
      assert.equal(q.rows.reduce((n, row) => n + row.count, 0), count / 20);
      const expected = observations.filter(([id]) => id.startsWith('e')).reduce((n, [, value]) => n + value, 0);
      assert.ok(Math.abs(q.rows.reduce((n, row) => n + row.total, 0) - expected) < 1e-10 * Math.max(1, Math.abs(expected)));
    }
    summary = { storedBuckets: buckets, learningSourceObservations: count / 20,
      learningReadBuckets: db.prepare("SELECT COUNT(*) AS n FROM summary_buckets WHERE kind='learning' AND target='e'").get().n,
      hundredQueriesMs: performance.now() - started };
  }
  db.close(); return { elapsedMs, sqlCalls, rowChangesExcludingIndexWrites: rowChanges, lastJsonBytes, seenRows, samples: observations.length, rewardDigest, summary };
}
const variants = {};
for (const enabled of [false, true]) {
  if (enabled && !IncrementalLearning.prototype.summaries && options.module) continue;
  run(enabled); // Warm-up.
  const runs = Array.from({ length: repeats }, () => run(enabled));
  for (const r of runs) assert.equal(r.rewardDigest, runs[0].rewardDigest);
  const median = key => [...runs].sort((a, b) => a[key] - b[key])[Math.floor(runs.length / 2)][key];
  variants[enabled ? 'summaries' : 'default'] = { ...runs[0], elapsedMs: median('elapsedMs'), runs };
}
if (variants.summaries) assert.equal(variants.default.rewardDigest, variants.summaries.rewardDigest);
const dictionary = [];
for (const batchSize of [1, 10, 100]) {
  for (const cached of [false, true]) {
    const cache = new DictionaryCache(), sent = { raw: 0, dictionary: 0, jsonBytes: 0 }, started = performance.now();
    const send = async batch => { for (const r of batch) { sent[r.table_name === 'attribute_keys' ? 'dictionary' : 'raw']++; sent.jsonBytes += Buffer.byteLength(JSON.stringify(r)); } };
    for (let i = 0; i < count; i += batchSize) {
      const rows = Array.from({ length: Math.min(batchSize, count - i) }, (_, j) => ({ record: rawRecords({ siteId: 'site', receivedAt: i + j, event: {
        kind: 'track', eventId: 't' + (i + j), occurredAt: i + j, subject: { cid: 'c' }, name: 'view',
        attributes: Object.fromEntries(Array.from({ length: 20 }, (_, k) => ['key' + k, 'v'])) } })[0] }));
      if (cached) await sendExportBatches(rows, send, cache); else for (const batch of exportBatches(rows)) await send(batch);
    }
    assert.equal(sent.raw, count);
    dictionary.push({ batchSize, cached, ...sent, elapsedMs: performance.now() - started });
  }
}
const result = { runtime: process.version, platform: process.platform + '/' + process.arch,
  sourceSha256: createHash('sha256').update(await readFile(modulePath)).digest('hex'),
  scriptSha256: createHash('sha256').update(await readFile(new URL('./run.mjs', import.meta.url))).digest('hex'),
  dictionarySourceSha256: createHash('sha256').update(await readFile(new URL('../../dist/analytics/export.js', import.meta.url))).digest('hex'),
  fixture: { events: count, relevantEvents: relevant.length, deliveredIncludingRetries: received.length, batchSize: 100, repeats },
  limitations: 'Synthetic local SQLite in memory; no network, index-write billing, durable fsync, export delivery, or sustained traffic. Optional summaries add writes; report query time is a local snapshot. Dictionary uses 20 stable daily keys and no eviction, not general workload savings.',
  variants, dictionary };
if (options.output) await writeFile(options.output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, variants: Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, { ...v, runs: undefined }])) }));
