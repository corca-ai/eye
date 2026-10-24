import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings } from '../../dist/core/validation.js';
import { reduceClosedCohort } from '../../dist/core/closed-cohort.js';
const directory = dirname(fileURLToPath(import.meta.url));
const { url } = JSON.parse(await readFile(join(directory, '.state/deployment.json')));
const { TEST_TOKEN } = JSON.parse(await readFile(join(directory, '.state/site-secrets.json')));
const headers = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };
const label = process.argv[2];
if (!label || !/^[a-z0-9_-]+$/i.test(label)) throw new Error('Supply a safe output label');
const fixturePath = join(directory, '.state/cohort-fixture.json');
let fixture;
try { fixture = JSON.parse(await readFile(fixturePath)); } catch {
  const until = Math.floor(Date.now() / 3600000) * 3600000, from = until - 3600000;
  const siteId = `cohort-${crypto.randomUUID()}`, events = [];
  const config = settings({ minHoldMs: 0 });
  for (let i = 0; i < 100; i++) {
    const subject = { cid: `browser-${i}`, ...(i % 2 ? { uid: `user-${i}` } : {}) };
    const startAt = from + i * 1000 - config.observationWindowMs - config.allowedLatenessMs;
    for (let exp = 0; exp < 3; exp++) {
      const sampleId = `sample-${i}-${exp}`;
      const assignment = { assignmentId: sampleId, experimentId: `exp-${exp}`, armId: `arm-${i % 3}`,
        generation: 1, policyRevision: 1, probability: 1 / 3, assignedAt: startAt, settings: config };
      for (let repeat = 0; repeat < 3; repeat++) events.push({ kind: 'exposure', eventId: `${sampleId}-${repeat}`,
        occurredAt: startAt + repeat * 86400000, subject, assignment, sample: { sampleId, startAt },
        attributionWindowMs: config.attributionWindowMs, userAttributes: { cohort: i % 2 ? 'uid' : 'cid' } });
    }
    if (i % 4 === 0) events.push({ kind: 'identify', eventId: `login-${i}`, occurredAt: startAt + 86400000, subject: { ...subject, uid: `user-${i}` } });
    if (i % 5 !== 0) for (let g = 0; g < 3; g++) events.push({ kind: 'goal', eventId: `goal-${i}-${g}`, occurredAt: startAt + (2 + g) * 86400000 + 100,
      subject: i % 4 === 0 ? { cid: `other-device-${i}`, uid: `user-${i}` } : subject, goalId: 'value', value: g === 1 ? -25 : 100 + i });
    for (let t = 0; t < 40; t++) events.push({ kind: 'track', eventId: `track-${i}-${t}`, occurredAt: startAt + t * 3600000,
      subject, name: 'page_view', attributes: { path: `/product/${t}`, detail: 'x'.repeat(256) } });
  }
  fixture = { siteId, from, until, events }; await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
}
if (process.argv.includes('--seed')) {
  const chunks = [];
  for (let i = 0; i < fixture.events.length; i += 100) chunks.push(fixture.events.slice(i, i + 100));
  for (let i = 0; i < chunks.length; i += 4) {
    await Promise.all(chunks.slice(i, i + 4).map(async chunk => {
      const response = await fetch(`${url}/benchmark/seed`, { method: 'POST', headers,
        body: JSON.stringify(chunk.map(event => ({ siteId: fixture.siteId, receivedAt: Date.now(), event }))), signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`Seed HTTP ${response.status}: ${await response.text()}`);
    }));
  }
  console.log(JSON.stringify({ seeded: fixture.events.length, siteId: fixture.siteId }));
} else {
  const started = performance.now();
  const response = await fetch(`${url}/benchmark/learn?site=${fixture.siteId}&from=${fixture.from}&until=${fixture.until}`, { method: 'POST', headers, signal: AbortSignal.timeout(600000) });
  if (!response.ok) throw new Error(`Learning HTTP ${response.status}: ${await response.text()}`);
  const result = await response.json();
  if (result.error) {
    await mkdir(join(directory, 'results'), { recursive: true });
    await writeFile(join(directory, `results/cohort-${label}-error.json`), JSON.stringify(result, null, 2));
    throw new Error(result.error);
  }
  const expected = reduceClosedCohort({ cohortId: 'expected', from: fixture.from, until: fixture.until, asOf: fixture.until,
    exposures: fixture.events.filter(e => e.kind === 'exposure').map(event => ({ event, ...event.sample, attributionWindowMs: event.attributionWindowMs })),
    goals: fixture.events.filter(e => e.kind === 'goal'), identities: fixture.events.filter(e => e.kind === 'identify' || e.kind === 'logout') });
  const actual = result.pages.flatMap(p => p.cohort.samples);
  const byId = new Map(actual.map(s => [s.sampleId, s]));
  const mismatch = expected.samples.filter(s => !byId.has(s.sampleId) || Math.abs(byId.get(s.sampleId).reward - s.reward) > 1e-8);
  const summary = { label, siteId: fixture.siteId, events: fixture.events.length, durationMs: performance.now() - started,
    expectedSamples: expected.samples.length, actualSamples: actual.length, mismatch: mismatch.length, queries: result.queries.length,
    metrics: result.queries.map(q => q.metrics) };
  await mkdir(join(directory, 'results'), { recursive: true });
  await writeFile(join(directory, `results/cohort-${label}.json`), JSON.stringify({ summary, result }, null, 2));
  console.log(JSON.stringify(summary));
  if (mismatch.length || actual.length !== expected.samples.length) process.exitCode = 1;
}
