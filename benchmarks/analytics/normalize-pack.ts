// Build baseline 8f3b611 first; pass its dist directory as the first argument.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { database } from '../../test/helpers/analytics-db.js';
import { settings } from '../../src/core/validation.js';
import type { EventEnvelope } from '../../src/core/types.js';
import { packIngestion, unpackEvents } from '../../src/runtime/queue-batch.js';
import { exposureProjection } from '../../src/analytics/projections-sql.js';
import { rawRecords } from '../../src/analytics/raw.js';
import { analyticsRecord } from '../../src/analytics/records.js';
import { jobCacheIdentity, validateJobRequest } from '../../src/analytics/job-query.js';
const baseline = process.argv[2];
assert.ok(baseline, 'Pass the baseline dist directory');
const load = (file: string) => import(pathToFileURL(resolve(baseline, file)).href);
const oldQueue = await load('runtime/queue-batch.js'), oldProjection = await load('analytics/projections-sql.js');
const now = 1_800_000_000_000, start = now - 10000;
const config = settings({ minHoldMs: 0, observationWindowMs: 1000, allowedLatenessMs: 0 });
function shown(i: number, unique = false, detail = ''): EventEnvelope {
  return { siteId: 'site', receivedAt: now - 10, event: { kind: 'exposure', eventId: `e-${i}`, occurredAt: start,
    subject: { cid: `c-${i}` }, assignment: { assignmentId: `a-${i}`, experimentId: 'exp', armId: 'a', generation: 1,
      assignedAt: start, policyRevision: 1, probability: 1, settings: unique ? { ...config, minHoldMs: i } : config },
    sample: { sampleId: `s-${i}`, startAt: start }, attributionWindowMs: 5000, attributes: { detail },
  } };
}
function median(work: () => unknown, iterations = 1): number {
  const measure = () => { const began = performance.now(); for (let i = 0; i < iterations; i++) work(); return (performance.now() - began) / iterations; };
  measure(); return [measure(), measure(), measure(), measure(), measure()].sort((a, b) => a - b)[2]!;
}
const cases: [string, EventEnvelope[]][] = [
  ['100 tracks', Array.from({ length: 100 }, (_, i) => ({ ...shown(i), event: { kind: 'track', eventId: `t-${i}`, occurredAt: start, subject: { cid: `c-${i}` }, name: 'view' } }))],
  ['one exposure', [shown(0)]],
  ['20 shared settings', Array.from({ length: 20 }, (_, i) => shown(i))],
  ['100 shared settings', Array.from({ length: 100 }, (_, i) => shown(i))],
  ['100 unique settings', Array.from({ length: 100 }, (_, i) => shown(i, true))],
  ['40 Unicode exposures', Array.from({ length: 40 }, (_, i) => shown(i, false, '한'.repeat(100)))],
  ['large valid singleton', [shown(0, false, 'x'.repeat(70000))]],
];
cases.push(['mixed kinds', cases[0]![1].map((event, i) => i % 3 === 0 ? shown(i) : i % 3 === 1 ? event : { ...event,
  event: { kind: 'goal', eventId: `g-${i}`, occurredAt: start, subject: { cid: `c-${i}` }, goalId: 'pay', value: i % 2 ? -100 : 100 } })]);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const queue = cases.map(([name, events]) => {
  const before = oldQueue.packIngestion(events), after = packIngestion(events);
  assert.deepEqual(before.flatMap(oldQueue.unpackEvents), events);
  assert.deepEqual(after.flatMap(unpackEvents), events);
  // Includes actual packet framing; approximate 100-byte platform metadata is
  // explicit in this size-unit estimate, not an observed platform charge.
  const units = (packets: unknown[]) => packets.reduce<number>((n, packet) => n + Math.ceil((bytes(packet) + 100) / 64000), 0);
  return { name, events: events.length, beforeMessages: before.length, afterMessages: after.length,
    beforeBytes: before.reduce((n: number, b: unknown) => n + bytes(b), 0), afterBytes: after.reduce((n, b) => n + bytes(b), 0),
    beforeEstimatedUnitsPerOperation: units(before), afterEstimatedUnitsPerOperation: units(after),
    beforePackMs: median(() => oldQueue.packIngestion(events), 100), afterPackMs: median(() => packIngestion(events), 100),
    beforeDecodeMs: median(() => before.flatMap(oldQueue.unpackEvents), 100), afterDecodeMs: median(() => after.flatMap(unpackEvents), 100) };
});
const projection = [];
for (const completed of [0, 950]) {
  const events = Array.from({ length: 1000 }, (_, i) => shown(i));
  const records = events.flatMap(envelope => Array.from({ length: 5 }, (_, j) => rawRecords({ ...envelope,
    event: { ...envelope.event, eventId: `${envelope.event.eventId}-${j}`, occurredAt: start + j } })).flat());
  for (let i = 0; i < completed; i++) {
    const row = analyticsRecord({ siteId: 'site', subjectKey: `c-${i}`, cid: `c-${i}` }, 'observations', `s-${i}`, 2, start, now - 5,
      { generation: 1, endAt: start + 1000 }, { experiment_id: 'exp', arm_id: 'a', observation_id: `s-${i}`, status: 'complete', value: i });
    records.push(row); if (i % 7 === 0) records.push({ ...row, received_at: now - 4 });
  }
  const db = database(records);
  try {
    const args = ['observations', 'o', 'eye', "'site'", start, start, now, now, ''] as const;
    const before = oldProjection.exposureProjection(...args), after = exposureProjection(...args);
    const query = (ctes: string) => `WITH ${ctes} SELECT * FROM o ORDER BY record_id`;
    assert.deepEqual(db.run(query(after)), db.run(query(before)));
    const rankInputs = db.run(`WITH ${after} SELECT COUNT(*) AS n FROM eye.events e LEFT JOIN o_closed_keys c ON c.closed_observation_id=e.observation_id WHERE c.closed_observation_id IS NULL`)[0]!.n;
    projection.push({ samples: 1000, completed, beforeRankInputs: 5000, afterRankInputs: rankInputs,
      beforeMs: median(() => db.run(query(before))), afterMs: median(() => db.run(query(after))) });
  } finally { db.close(); }
}
const a = { field: { key: 'x', type: 'number' as const }, op: 'eq' as const, value: 1 };
const b = { field: { key: 'y', type: 'string' as const }, op: 'missing' as const };
const requests = [{ and: [a, b] }, { and: [b, a] }, { and: [a, { and: [b, a] }] }].map(filter => validateJobRequest('site', {
  kind: 'goals', query: { from: start, to: now, filter },
}, now));
assert.equal(new Set(requests.map(jobCacheIdentity)).size, 1);
console.log(JSON.stringify({ baseline: '8f3b611', runtime: process.version, platform: process.platform,
  method: 'Same immutable inputs, exact decoded envelopes and projection rows; one warmup + five measured runs, median. Queue timings are per batch.',
  limitations: 'Synthetic local memory SQLite and encoding/decoding only; no remote Basin plan, durable I/O, network, retry amplification or measured billing. Cache identity count is not a workload hit rate.',
  queue, projection, cache: { beforeIdentities: new Set(requests).size, afterIdentities: new Set(requests.map(jobCacheIdentity)).size },
}, null, 2));
