// Run after npm run build. This is a local algorithm experiment, not a Basin cost model.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { LearningSource, reduceLearningPage } from './reference-source.mjs';
import { reduceClosedCohort } from '../../dist/core/closed-cohort.js';
import { compareEvents } from '../../dist/core/attribution.js';
import { emptyMoments, mergeMoments, meanOf, stddevOf } from '../../dist/core/moments.js';
import { rawRecords } from '../../dist/analytics/raw.js';
import { IncrementalLearning } from '../../dist/runtime/incremental.js';
import { settings } from '../../dist/core/validation.js';

const args = process.argv.slice(2);
const option = (name, fallback) => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const sizes = option('sizes', '2000,10000,50000,100000').split(',').map(Number);
const repeats = Number(option('repeats', '3'));
assert.ok(sizes.every(n => Number.isSafeInteger(n) && n >= 20 && n % 20 === 0));
assert.ok(Number.isSafeInteger(repeats) && repeats >= 1);
const output = resolve(option('output', 'benchmarks/local-learning/results.json'));
const day = 86_400_000, hour = 3_600_000;
const base = Math.floor(1_800_000_000_000 / hour) * hour;
const config = settings({ minHoldMs: 0, observationWindowMs: 7 * day,
  allowedLatenessMs: hour, attributionHalfLifeMs: day, attributionWindowMs: day });
const from = base + config.observationWindowMs + config.allowedLatenessMs;
const until = from + hour, now = until + 1;
const env = { EYE_ANALYTICS_WAREHOUSE: `${'a'.repeat(32)}_local-benchmark`, EYE_ANALYTICS_TOKEN: 'local-only' };
const bounds = { windowMs: config.observationWindowMs, graceMs: config.allowedLatenessMs, attributionMs: day };

function fixture(count) {
  const events = [];
  for (let user = 0; user < count / 20; user++) {
    const suffix = String(user).padStart(8, '0'), cid = `browser-${suffix}`, uid = `user-${suffix}`;
    const start = base + (user * 37013 % (50 * 60_000));
    let sequence = 0;
    const emit = (kind, at, payload, subject = { cid, uid }) => {
      events.push({ kind, eventId: `${suffix}-${String(sequence++).padStart(3, '0')}`, occurredAt: at, subject, ...payload });
    };
    emit('identify', start - 1000, {});
    for (const experimentId of ['checkout', 'banner']) {
      const offset = experimentId === 'checkout' ? 0 : 1000;
      const firstAt = start + offset;
      const assignment = { assignmentId: `${suffix}-${experimentId}`, experimentId,
        armId: user % 2 ? 'b' : 'a', assignedAt: firstAt, generation: 1, policyRevision: 1,
        probability: .5, settings: config };
      for (const elapsed of [0, day, 3 * day, 6 * day]) emit('exposure', firstAt + elapsed, {
        assignment, sample: { sampleId: `${suffix}-${experimentId}`, startAt: firstAt }, attributionWindowMs: day,
      });
    }
    emit('goal', start + day + 2000, { goalId: 'purchase', value: user % 5 ? 100 : -30 }, { cid: `other-${suffix}`, uid });
    emit('goal', start + 6 * day + 2000, { goalId: 'purchase', value: user % 3 ? 70 : -20 }, { cid: `other-${suffix}`, uid });
    for (let i = 0; i < 9; i++) emit('track', start + i * day / 2, { name: 'page_view' });
  }
  assert.equal(events.length, count);
  return events;
}

function cohortInput(events) {
  return { cohortId: 'reference', from, until, asOf: until,
    exposures: events.filter(e => e.kind === 'exposure').map(event => ({ event,
      sampleId: event.sample.sampleId, startAt: event.sample.startAt, attributionWindowMs: event.attributionWindowMs })),
    goals: events.filter(e => e.kind === 'goal'), identities: events.filter(e => e.kind === 'identify' || e.kind === 'logout') };
}
function rewardMap(samples) { return new Map(samples.map(s => [s.sampleId, s.reward])); }
function compareRewards(expected, actual, exact = true) {
  assert.equal(actual.size, expected.size, 'sample population');
  let changed = 0, absoluteError = 0, absoluteReference = 0, signedError = 0, maxSampleError = 0;
  for (const [id, reward] of expected) {
    assert.ok(actual.has(id));
    const difference = Math.abs(reward - actual.get(id));
    if (difference > 1e-10 * Math.max(1, Math.abs(reward))) changed++;
    absoluteError += difference; absoluteReference += Math.abs(reward);
    signedError += actual.get(id) - reward; maxSampleError = Math.max(maxSampleError, difference);
  }
  if (exact) assert.equal(changed, 0, 'sample rewards');
  return { samples: expected.size, changedSamples: changed,
    sumAbsoluteRewardError: absoluteError, signedRewardError: signedError, maxSampleError,
    absoluteErrorOverAbsoluteReference: absoluteError / (absoluteReference || 1) };
}
function digest(samples) {
  return createHash('sha256').update(JSON.stringify([...samples].sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
}

// Only the three scalar JSON accesses in LearningSource are translated. Native
// SQLite JSON avoids making JS JSON.parse callbacks the measured bottleneck.
function sqliteSQL(query) {
  const sql = query.replace(/json_get_(?:str|int)\(payload_json, '([A-Za-z]+)'\)/g,
    (_, key) => `json_extract(payload_json, '$.${key}')`);
  assert.ok(!sql.includes('json_get_'), 'unsupported SQL translation');
  return sql;
}
function sourceDatabase(events) {
  const db = new DatabaseSync(':memory:');
  db.exec("ATTACH DATABASE ':memory:' AS eye");
  const example = rawRecords({ siteId: 'site', receivedAt: now - 1, event: events[0] })[0];
  const columns = Object.keys(example);
  for (const table of ['events', 'identity_links']) db.exec(`CREATE TABLE eye.${table} (${columns.map(k =>
    `"${k}" ${['schema_version','revision','occurred_at','received_at','value'].includes(k) ? 'REAL' : 'TEXT'}`).join(',')})`);
  const inserts = Object.fromEntries(['events','identity_links'].map(t => [t,
    db.prepare(`INSERT INTO eye.${t} VALUES (${columns.map(() => '?').join(',')})`)]));
  db.exec('BEGIN');
  for (const event of events) for (const row of rawRecords({ siteId: 'site', receivedAt: now - 1, event }))
    if (inserts[row.table_name]) inserts[row.table_name].run(...columns.map(k => row[k]));
  db.exec('COMMIT');
  return db;
}
async function scanLearner(db, pageSize, capturePlans = false) {
  const metrics = { targetQueries: 0, rawQueries: 0, targetSqlMs: 0, rawSqlMs: 0, returnedRows: 0, responseBytes: 0 };
  const plans = {};
  const request = async (_url, init) => {
    const sql = sqliteSQL(JSON.parse(init.body).query);
    const phase = sql.startsWith('WITH links') ? 'raw' : 'target';
    if (capturePlans && !plans[phase]) plans[phase] = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(r => r.detail);
    const started = performance.now();
    const rows = db.prepare(sql).all();
    metrics[`${phase}SqlMs`] += performance.now() - started;
    metrics[`${phase}Queries`]++;
    metrics.returnedRows += rows.length;
    // Deliberately omit bytes_scanned: returned bytes are not scanned bytes.
    const body = JSON.stringify({ success: true, result: { rows } });
    metrics.responseBytes += Buffer.byteLength(body);
    return new Response(body, { headers: { 'Content-Type': 'application/json' } });
  };
  const source = new LearningSource(env, 'site', bounds, request, () => now);
  const samples = new Map(), records = [];
  let after = '', pages = 0;
  const started = performance.now();
  for (;;) {
    const page = await source.page(from, until, after, pageSize);
    pages++;
    records.push(...page.records);
    for (const sample of page.cohort.samples) {
      assert.ok(!samples.has(sample.sampleId), 'duplicate sample'); samples.set(sample.sampleId, sample.reward);
    }
    if (page.next === null) break;
    after = page.next;
  }
  return { samples, records, measurement: { totalMs: performance.now() - started, pages, ...metrics }, plans };
}

// Execute the production learner against local SQLite. The raw-query baseline
// is historical; all current state/reward/outbox logic is imported from dist.
function incrementalLearner(events, arrivalMode) {
  const db = new DatabaseSync(':memory:');
  let calls = 0;
  const engine = new IncrementalLearning({ exec(query, ...bindings) {
    calls++;
    let rows;
    if (query.trimStart().startsWith('CREATE ')) { db.exec(query); rows = []; }
    else rows = db.prepare(query).all(...bindings);
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } });
  calls = 0;
  let random = 123456;
  const rand = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 2 ** 32; };
  let delayedEvents = 0;
  const relevant = events.filter(e => e.kind !== 'track').map(event => {
    const delay = arrivalMode.startsWith('delayed-') && rand() < .02 ? (delayedEvents++, Math.floor(rand() * 5000)) : 0;
    return { event, arrival: event.occurredAt + delay };
  }).sort((a, b) => a.arrival - b.arrival || compareEvents(a.event, b.event));
  const received = relevant.flatMap((x, i) => i % 101 === 0 ? [x, x] : [x]);
  if (relevant.length) received.push(relevant[0]);
  let transactions = 0, reverseArrivals = 0, frontier = -Infinity;
  const inspectedIds = new Set();
  const diagnostics = { staleExposures: 0, staleIdentities: 0, futureExposures: 0, closedGoals: 0 };
  const started = performance.now();
  for (let offset = 0; offset < received.length; offset += 100) {
    const part = received.slice(offset, offset + 100);
    const batch = part.map(x => x.event);
    const admittedAt = Math.max(...part.map(x => x.arrival));
    const inspected = arrivalMode === 'delayed-arrival' ? batch : [...batch].sort(compareEvents);
    for (const event of inspected) {
      if (inspectedIds.has(event.eventId)) continue;
      inspectedIds.add(event.eventId);
      if (event.occurredAt < frontier) reverseArrivals++;
      frontier = Math.max(frontier, event.occurredAt);
    }
    db.exec('BEGIN'); transactions++;
    // Unsorted is an accuracy control: invoke the same production learner one
    // event at a time within this transaction, defeating batch-local sorting.
    const groups = arrivalMode === 'delayed-arrival' ? batch.map(e => [e]) : [batch];
    for (const group of groups) {
      const receipt = engine.accept(group, admittedAt);
      for (const key of Object.keys(diagnostics)) diagnostics[key] += receipt.diagnostics[key];
    }
    db.exec('COMMIT');
  }
  for (;;) {
    db.exec('BEGIN'); transactions++;
    const count = engine.close('site', until);
    db.exec('COMMIT');
    if (count === 0) break;
  }
  const totalMs = performance.now() - started;
  const preparedStatementCalls = calls;
  const rowChanges = db.prepare('SELECT total_changes() AS n').get().n;
  // Output delivery/draining is excluded on both paths; records were already
  // constructed and serialized durably during timed production learner calls.
  const samples = new Map(), records = [], armMoments = new Map();
  for (;;) {
    const pending = engine.outputs();
    if (!pending.length) break;
    for (const { output } of pending) {
      records.push(...output.records);
      for (const record of output.records) if (record.table_name === 'observations') samples.set(record.record_id, record.value);
      for (const arm of output.cohort?.arms ?? []) {
        const key = JSON.stringify([arm.experimentId, arm.generation, arm.armId]);
        armMoments.set(key, mergeMoments(armMoments.get(key) ?? emptyMoments(until), arm.moments));
      }
    }
    engine.acknowledge(pending.map(item => item.id));
  }
  db.close();
  return { samples, records, armMoments, measurement: { totalMs, relevantEvents: relevant.length,
    receivedEventsIncludingRetries: received.length, delayedEvents, reverseArrivals, ...diagnostics,
    preparedStatementCallsExcludingTransactions: preparedStatementCalls,
    sqliteRowChangesExcludingIndexWrites: rowChanges, transactions,
    creditRows: records.filter(row => row.table_name === 'credits').length } };
}
function verifyMoments(expected, actual) {
  for (const arm of expected.arms) {
    const key = JSON.stringify([arm.experimentId, arm.generation, arm.armId]);
    const got = actual.get(key); assert.ok(got);
    for (const [a, b] of [[arm.moments.weight, got.weight], [meanOf(arm.moments), meanOf(got)], [stddevOf(arm.moments), stddevOf(got)]])
      assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)), `Moments differ: ${a} / ${b}`);
  }
  assert.equal(expected.arms.length, actual.size);
}
function momentDifferences(expected, actual) {
  return expected.arms.map(arm => {
    const key = JSON.stringify([arm.experimentId, arm.generation, arm.armId]), got = actual.get(key);
    assert.ok(got);
    return { experimentId: arm.experimentId, armId: arm.armId, referenceMean: meanOf(arm.moments),
      meanDifference: meanOf(got) - meanOf(arm.moments), weightDifference: got.weight - arm.moments.weight,
      stddevDifference: stddevOf(got) - stddevOf(arm.moments) };
  });
}
function checkIdentityAndRewardBoundaries() {
  const anon = { cid: 'browser' }, a = { cid: 'browser', uid: 'a' }, b = { cid: 'browser', uid: 'b' };
  const expose = (id, experimentId, at, subject, options = {}) => {
    const assignment = { assignmentId: options.assignmentId ?? id, experimentId, armId: options.armId ?? 'a',
      assignedAt: base, generation: 1, policyRevision: 1, probability: .5,
      settings: { ...config, observationWindowMs: options.window ?? config.observationWindowMs } };
    return { kind: 'exposure', eventId: id, occurredAt: base + at, subject, assignment,
      sample: { sampleId: options.sampleId ?? id, startAt: base + (options.start ?? at) },
      attributionWindowMs: options.lookback ?? day };
  };
  const goal = (id, at, value, subject = a) => ({ kind: 'goal', eventId: id, occurredAt: base + at,
    subject, goalId: 'purchase', value });
  const identity = (id, at, subject, kind = 'identify') => ({ kind, eventId: id, occurredAt: base + at, subject });
  const cases = {
    identity: [expose('a0', 'e', 0, anon), goal('before-login', 1000, 100),
      identity('login-a', 2000, a), goal('other-device', 3000, 10, { cid: 'other', uid: 'a' }),
      expose('ambiguous-anon', 'e', 3500, anon), identity('logout', 4000, anon, 'logout'),
      expose('fresh-anon', 'e', 4500, anon), identity('login-b', 5000, b), goal('b-goal', 6000, -20, b),
      identity('switch-a', 7000, a), goal('a-again', 8000, 30, a)],
    latestAndForcedSwitch: [expose('old', 'e', 0, a), expose('latest', 'e', 2000, a, { lookback: 5, armId: 'b' }),
      expose('other', 'f', 1000, a), goal('expired-goal', 3000, 100),
      expose('repeat', 'f', 4000, a, { assignmentId: 'other', sampleId: 'other', start: 1000 }),
      goal('negative', 5000, -10)],
    outsideObservation: [expose('closed', 'e', 0, a, { window: 10 }),
      expose('open', 'f', 1000, a), goal('split', 3000, 100)],
    equalTime: [expose('a', 'e', 0, anon), identity('b', 0, a), goal('z', 0, 100)],
    extremeSigned: [expose('a', 'e', 0, a), goal('g0', 0, 1e308), goal('g1', 0, 1e308), goal('g2', 0, -1e308)],
  };
  for (const [name, events] of Object.entries(cases)) {
    const reference = reduceClosedCohort({ ...cohortInput(events), from: 0 }), result = incrementalLearner(events, 'ordered');
    compareRewards(rewardMap(reference.samples), result.samples); verifyMoments(reference, result.armMoments);
    assert.ok(result.measurement.receivedEventsIncludingRetries > events.length, 'duplicate delivery exercised');
  }
  return Object.keys(cases);
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const orderRecords = rows => rows.filter(row => row.table_name === 'observations').map(row => ({ ...row, received_at: 0,
  payload_json: JSON.parse(row.payload_json), attributes_json: JSON.parse(row.attributes_json),
})).sort((a, b) => a.table_name.localeCompare(b.table_name) || a.record_id.localeCompare(b.record_id));
function summarize(runs) {
  return Object.fromEntries(Object.keys(runs[0]).map(key => [key, median(runs.map(r => r[key]))]));
}
const sourceFiles = ['./reference-source.mjs', '../../dist/runtime/incremental.js', '../../dist/core/reward-sum.js', '../../dist/analytics/query.js', '../../dist/core/closed-cohort.js',
  '../../dist/core/moments.js', '../../dist/core/identity-history.js', '../../dist/core/attribution.js',
  '../../dist/core/events.js', '../../dist/analytics/records.js', '../../dist/analytics/raw.js', '../../dist/core/validation.js'];
const digests = {};
for (const path of ['./run.mjs', ...sourceFiles])
  digests[path] = createHash('sha256').update(await readFile(new URL(path, import.meta.url))).digest('hex');
const versionDb = new DatabaseSync(':memory:');
const sqliteVersion = versionDb.prepare('SELECT sqlite_version() AS version').get().version;
versionDb.close();
const report = { recordedAt: new Date().toISOString(), runtime: process.version, sqliteVersion,
  platform: `${process.platform}/${process.arch}`, sourceDigests: digests, seed: 123456,
  repeats, warmupsPerVariant: 1, fixture: { eventsPerUser: 20, experimentsPerUser: 2, exposuresPerUser: 8,
    goalsPerUser: 2, identitiesPerUser: 1, tracksPerUser: 9, closingIntervalMs: hour, observationWindowMs: 7 * day,
    sourceIndexes: 'none; SQLite query plans perform repeated full table scans',
    variantOrder: 'fixed; use raw repetitions, not close differences, for interpretation',
    delayInjection: 'seeded 2% of learning-relevant events delayed uniformly 0..4999ms; batches of 100 with/without local sorting' },
  limitations: [
    'Synthetic fixed, fully visible input: not events/day or sustained production throughput.',
    'All samples close in one hour; growing size grows both retained source data and closing population. This is concentrated backlog drain, not isolated history sensitivity.',
    'SQLite in-memory, native JSON translation, no network or durable fsync: NOT Basin planner, scanned bytes, pricing, or Cloudflare SQLite billing.',
    'Raw source loading excluded; incremental learner state/dedup/observation-outbox SQL included. Output transmission, remote policy apply and source ingestion excluded for both. No per-goal credits projection is persisted.',
    'Incremental starts with decoded/routed input; synthetic arrival preparation excluded. Scan includes source event decoding/validation. Observation business records match after normalizing their receipt clocks.',
    'Source query plans captured from SQLite; only returned response bytes measured, never interpreted as scanned bytes.',
    'All timed samples finalized after all fixture events: production concurrency, delivery failure and eviction are validated separately by workerd tests, not these timings.',
    'Production IncrementalLearning is timed including durable dedup/reward/outbox operations; unsorted mode is an accuracy control that calls accept per event. No disk fsync or outbox delivery.',
    'Delay error describes this workload only; no bound or unbiasedness guarantee for real traffic.',
    'Timed traffic always has explicit uid; delay impact on anonymous ownership/logout/account changes is not measured.',
  ], results: [] };
report.untimedCorrectnessCases = checkIdentityAndRewardBoundaries();
for (const count of sizes) {
  const events = fixture(count), reference = reduceClosedCohort(cohortInput(events)), expected = rewardMap(reference.samples);
  const referenceRecords = orderRecords(reduceLearningPage('site', 'reference', from, until,
    [...expected.keys()], events, null, now).records);
  const db = sourceDatabase(events);
  const entry = { inputEvents: count, users: count / 20, samples: expected.size, variants: {} };
  for (const pageSize of [50, 200]) {
    const runs = [];
    let plans;
    for (let run = -1; run < repeats; run++) {
      const result = await scanLearner(db, pageSize, run === -1);
      compareRewards(expected, result.samples);
      assert.deepEqual(orderRecords(result.records), referenceRecords, 'full scan analytics output');
      if (run >= 0) runs.push(result.measurement);
      if (run === -1) plans = result.plans;
    }
    entry.variants[`scan-page-${pageSize}`] = { median: summarize(runs), runs, plans,
      rewardCheck: 'matched all reference samples and observation business records (excluding received_at)' };
    console.log(JSON.stringify({ inputEvents: count, variant: `scan-page-${pageSize}`, median: summarize(runs) }));
  }
  db.close();
  for (const mode of ['ordered', 'delayed-arrival', 'delayed-batch']) {
    const runs = [];
    let comparison, perArm;
    for (let run = -1; run < repeats; run++) {
      const result = incrementalLearner(events, mode);
      comparison = compareRewards(expected, result.samples, mode === 'ordered');
      perArm = momentDifferences(reference, result.armMoments);
      if (mode === 'ordered') {
        verifyMoments(reference, result.armMoments);
        assert.deepEqual(orderRecords(result.records), referenceRecords, 'full ordered incremental analytics output');
      }
      if (run >= 0) runs.push(result.measurement);
    }
    entry.variants[`incremental-${mode}`] = { median: summarize(runs), runs, comparison, perArm };
    console.log(JSON.stringify({ inputEvents: count, variant: `incremental-${mode}`, median: summarize(runs), comparison }));
  }
  entry.referenceRewardDigest = digest(expected);
  report.results.push(entry);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}

// A single sample's related input exceeds the hard query budget. A smaller page
// cannot fix it; exercise both the ordinary and minimum page sizes explicitly.
const hot = fixture(20).find(e => e.kind === 'exposure');
const hotEvents = Array.from({ length: 10001 }, (_, i) => ({ ...hot, eventId: `hot-${String(i).padStart(6, '0')}`,
  occurredAt: hot.occurredAt + i }));
const hotDb = sourceDatabase(hotEvents);
report.hotIdentity = [];
for (const pageSize of [50, 1]) {
  try { await scanLearner(hotDb, pageSize); assert.fail('expected learning row budget failure'); }
  catch (error) {
    assert.match(error.message, /row budget/);
    report.hotIdentity.push({ relevantEvents: hotEvents.length, samples: 1, pageSize, error: error.message });
  }
}
hotDb.close();
const hotIncremental = incrementalLearner(hotEvents, 'ordered');
assert.equal(hotIncremental.samples.size, 1);
assert.equal([...hotIncremental.samples.values()][0], 0);
report.hotIdentityIncremental = { samples: 1, reward: 0, measurement: hotIncremental.measurement };
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, hotIdentity: report.hotIdentity }));
