// Build both revisions first. Same fixture/script measures each complete dist tree.
// node benchmarks/incremental-cost/run.mjs --dist=dist --output=/tmp/cost.json
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const dist = resolve(options.dist ?? 'dist'), repeats = Number(options.repeats ?? 5);
assert.ok(Number.isSafeInteger(repeats) && repeats > 0);
const load = path => import(pathToFileURL(resolve(dist, path)).href);
const { IncrementalLearning } = await load('runtime/incremental.js');
const { settings } = await load('core/validation.js');
const { rawRecords } = await load('analytics/raw.js');
const { DictionaryCache, sendExportBatches } = await load('analytics/export.js');
const config = settings({ minHoldMs: 0, observationWindowMs: 1000, attributionHalfLifeMs: 1000 });
function exposure(id, at, experimentId = 'e', attrs = '') {
  return { kind: 'exposure', eventId: id, occurredAt: at, subject: { cid: 'c', uid: 'u' },
    assignment: { assignmentId: id, experimentId, armId: 'a', generation: 1, assignedAt: at, probability: 1, policyRevision: 1, settings: config },
    sample: { sampleId: id, startAt: at }, attributionWindowMs: 10000, userAttributes: { large: attrs } };
}
function open() {
  const db = new DatabaseSync(':memory:'), counts = { lastRows: 0, sampleBytes: 0 };
  const sql = { exec(query, ...bindings) {
    let rows;
    if (query.trimStart().startsWith('CREATE ')) { db.exec(query); rows = []; } else rows = db.prepare(query).all(...bindings);
    if (query.startsWith('SELECT') && query.includes('FROM learning_last')) counts.lastRows += rows.length;
    if (query.startsWith('SELECT') && query.includes('FROM learning_samples')) counts.sampleBytes += Buffer.byteLength(JSON.stringify(rows));
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  return { db, counts, engine: new IncrementalLearning(sql) };
}
const pointReads = [];
for (const experiments of [1, 10, 100, 1000]) {
  const { db, engine, counts } = open();
  const events = Array.from({ length: experiments }, (_, i) => exposure('s' + i, 10, 'e' + i));
  engine.accept(events, 10); counts.lastRows = 0;
  engine.accept([{ ...events[0], eventId: 'repeat', occurredAt: 20 }], 20);
  pointReads.push({ experiments, lastReferenceRows: counts.lastRows }); db.close();
}
const rewardReads = [];
for (const attributeBytes of [0, 25000]) for (const batchSize of [1, 100]) {
  const { db, engine, counts } = open();
  engine.accept([exposure('sample', 10, 'e', 'x'.repeat(attributeBytes))], 10); counts.sampleBytes = 0;
  const goals = Array.from({ length: 100 }, (_, i) => ({ kind: 'goal', eventId: 'g' + i, occurredAt: 20 + i, subject: { cid: 'c', uid: 'u' }, goalId: 'pay', value: i - 30 }));
  for (let i = 0; i < goals.length; i += batchSize) engine.accept(goals.slice(i, i + batchSize), 200);
  const sampleResultBytes = counts.sampleBytes;
  engine.close('site', 62_000, () => {});
  const reward = engine.outputs().flatMap(o => o.output.records)[0].value;
  const expected = goals.reduce((sum, g) => sum + g.value * 2 ** (-(g.occurredAt - 10) / config.attributionHalfLifeMs), 0);
  assert.ok(Math.abs(reward - expected) < 1e-10);
  rewardReads.push({ attributeBytes, batchSize, sampleResultBytes, reward }); db.close();
}
function alarms() {
  const { db, engine } = open(); let scheduled = null, wakes = 0, cohorts = 0, samples = 0;
  const flush = now => {
    wakes++; engine.close('site', now, () => {});
    const outputs = engine.outputs(); cohorts += outputs.length;
    for (const { output } of outputs) { samples += output.records.length; assert.ok(output.records.every(r => r.value === 0)); }
    engine.acknowledge(outputs.map(o => o.id)); scheduled = engine.nextWake(now, true);
  };
  for (let i = 0; i < 10000; i++) {
    const now = i * 8640;
    while (scheduled !== null && scheduled <= now) flush(scheduled);
    engine.accept([exposure('s' + i, now)], now);
    const next = engine.nextWake(now);
    if (scheduled === null || (next !== null && next < scheduled)) scheduled = next;
  }
  while (scheduled !== null && scheduled <= 86400000 + 60000) flush(scheduled);
  assert.equal(samples, 10000); db.close(); return { exposures: 10000, spacingMs: 8640, wakes, cohorts, samples };
}
const rows = Array.from({ length: 10000 }, (_, i) => ({ record: rawRecords({ siteId: 'site', receivedAt: i,
  event: { kind: 'track', eventId: 't' + i, occurredAt: i, subject: { cid: 'c' }, name: 'view',
    attributes: Object.fromEntries(Array.from({ length: 20 }, (_, k) => ['k' + k, 'v'])) } })[0] }));
async function dictionary() {
  const cache = new DictionaryCache(), hash = createHash('sha256'); let constructed = 0, raw = 0, emitted = 0;
  const stringify = JSON.stringify;
  // Count dictionary payload construction before suppression, in both revisions.
  JSON.stringify = function(value, ...args) {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'key' in value && 'type' in value && 'source' in value) constructed++;
    return stringify(value, ...args);
  };
  const start = performance.now();
  try {
    for (let i = 0; i < rows.length; i += 100) await sendExportBatches(rows.slice(i, i + 100), async batch => {
      for (const record of batch) {
        if (record.table_name === 'attribute_keys') emitted++; else raw++;
        hash.update(stringify(record));
      }
    }, cache);
  } finally { JSON.stringify = stringify; }
  assert.equal(raw, 10000); assert.equal(emitted, 20);
  return { constructed, raw, emitted, outputDigest: hash.digest('hex'), elapsedMs: performance.now() - start };
}
await dictionary();
const runs = []; for (let i = 0; i < repeats; i++) runs.push(await dictionary());
for (const run of runs) assert.equal(run.outputDigest, runs[0].outputDigest);
const files = ['runtime/incremental.js', 'analytics/export.js', 'analytics/records.js'];
const sourceHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(resolve(dist, file))).digest('hex')])));
const result = { runtime: process.version, platform: process.platform + '/' + process.arch, repeats, sourceHashes,
  scriptSha256: createHash('sha256').update(await readFile(new URL('./run.mjs', import.meta.url))).digest('hex'),
  limitations: 'Synthetic memory SQLite, no durable storage/network/platform scheduling/billing. JSON result bytes are not SQLite page reads. Dictionary timing includes counting instrumentation, stable daily keys, one isolate, no eviction. Alarms omit export delay, failures and backlog.',
  pointReads, rewardReads, alarms: alarms(), dictionary: { ...runs[0], elapsedMs: runs.map(r => r.elapsedMs).sort((a, b) => a - b)[Math.floor(repeats / 2)], runs } };
if (options.output) await writeFile(options.output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
