// npm run build && node benchmarks/experiment-infrastructure/run.mjs --output=/tmp/eye-infrastructure.json
// --dist can point to a separately built revision for apples-to-apples comparison.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const dist = resolve(options.dist ?? 'dist');
const { IncrementalLearning } = await import(pathToFileURL(resolve(dist, 'runtime/incremental.js')));
const { settings } = await import(pathToFileURL(resolve(dist, 'core/validation.js')));
const start = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
const config = settings({ minHoldMs: 0, observationWindowMs: 60_000, attributionHalfLifeMs: 60_000 });
function run(experiments) {
  const db = new DatabaseSync(':memory:');
  const counters = { statements: 0, dashboardWrites: 0, lastRows: 0 };
  const sql = { exec(query, ...bindings) {
    counters.statements++;
    if (/^(INSERT|UPDATE).*dashboard_buckets/.test(query)) counters.dashboardWrites++;
    let rows;
    if (query.trimStart().startsWith('CREATE ')) { db.exec(query); rows = []; }
    else rows = db.prepare(query).all(...bindings);
    if (query.startsWith('SELECT') && query.includes('FROM learning_last')) counters.lastRows += rows.length;
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  const engine = new IncrementalLearning(sql, start);
  const subjects = 100, goalsPerSubject = 10;
  const exposures = Array.from({ length: subjects * experiments }, (_, i) => {
    const eventId = `exposure-${i}`, subject = { cid: `visitor-${Math.floor(i / experiments)}` };
    return { kind: 'exposure', eventId, occurredAt: start, subject,
      assignment: { assignmentId: eventId, experimentId: `e${i % experiments}`, armId: 'a', generation: 1,
        assignedAt: start, policyRevision: 1, probability: 1, settings: config },
      sample: { sampleId: eventId, startAt: start }, attributionWindowMs: 60_000 };
  });
  const goals = Array.from({ length: subjects * goalsPerSubject }, (_, i) => ({ kind: 'goal', eventId: `goal-${i}`,
    occurredAt: start + 1000, subject: { cid: `visitor-${Math.floor(i / goalsPerSubject)}` }, goalId: 'pay', value: 100 }));
  for (const key of Object.keys(counters)) counters[key] = 0;
  const accept = events => { for (let i = 0; i < events.length; i += 100) engine.accept(events.slice(i, i + 100), start + 2000); };
  const before = performance.now(); accept(exposures); const exposed = performance.now(); accept(goals); const learned = performance.now();
  const ingestion = { ...counters };
  const report = engine.dashboard.query({ experimentId: 'e0', boundaries: [start, start + 60_000] }, start + 60_000);
  const queried = performance.now();
  assert.equal(report.traffic[0].exposures, subjects); assert.equal(report.traffic[0].assignments, subjects);
  assert.equal(report.rewards[0].goals, goals.length);
  const expected = subjects * goalsPerSubject * 100 / experiments * 2 ** (-1000 / 60_000);
  assert.ok(Math.abs(report.rewards[0].totalValue / expected - 1) < 1e-12);
  const rows = db.prepare('SELECT COUNT(*) AS count FROM dashboard_buckets').get().count;
  assert.equal(db.prepare('SELECT rows FROM dashboard_state').get().rows, rows);
  db.close();
  return { exposuresMs: exposed - before, goalsMs: learned - exposed, reportMs: queried - learned,
    ingestion, dashboardRows: rows, reward: report.rewards[0].totalValue };
}
const workloads = [];
for (const experiments of [1, 10, 100]) {
  run(experiments);
  const runs = Array.from({ length: 5 }, () => run(experiments));
  const median = key => runs.map(r => r[key]).sort((a, b) => a - b)[2];
  workloads.push({ experiments, subjects: 100, goals: 1000, batchSize: 100,
    median: Object.fromEntries(['exposuresMs', 'goalsMs', 'reportMs'].map(key => [key, median(key)])), runs });
}
const sourceHashes = Object.fromEntries(await Promise.all(['runtime/incremental.js', 'runtime/dashboard.js'].map(async file =>
  [file, createHash('sha256').update(await readFile(resolve(dist, file))).digest('hex')])));
const result = { runtime: process.version, platform: `${process.platform}/${process.arch}`, sourceHashes,
  limitations: 'Local in-memory SQLite, dashboard coverage enabled. No Worker scheduling, durable disk commit, Queue or network latency; SQL counters are statements, not billed rows.', workloads };
if (options.output) await writeFile(options.output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
