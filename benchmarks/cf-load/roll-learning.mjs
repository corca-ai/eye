import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LearningSource } from '../local-learning/reference-source.mjs';
import { reduceClosedCohort } from '../../dist/core/closed-cohort.js';
const directory = dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(await readFile(join(directory, '.state/resources.json')));
const original = JSON.parse(await readFile(join(directory, '.state/cohort-fixture.json')));
const fixture = JSON.parse(await readFile(join(directory, '.state/roll-fixture.json')));
if (fixture.rounds.length !== 6 || fixture.rounds.some(r => !r.completedAt)) throw new Error('Finish seeding first');
const reference = reduceClosedCohort({ cohortId: 'reference', from: original.from, until: original.until, asOf: original.until,
  exposures: original.events.filter(e => e.kind === 'exposure').map(event => ({ event, ...event.sample, attributionWindowMs: event.attributionWindowMs })),
  goals: original.events.filter(e => e.kind === 'goal'), identities: original.events.filter(e => e.kind === 'identify' || e.kind === 'logout') });
const expected = new Map(Array.from({ length: 6 }, (_, round) => reference.samples.map(s => [`r${round}:${s.sampleId}`, s.reward])).flat()), results = {};
for (const namespace of ['eye', 'eye_roll300']) {
  const queries = [];
  const measured = async (url, init) => {
    const response = await fetch(url, init), body = await response.clone().json();
    queries.push({ status: response.status, metrics: body.result?.metrics, errors: body.errors }); return response;
  };
  const source = new LearningSource({ EYE_ANALYTICS_WAREHOUSE: `${state.account}_${state.prefix}-data`, EYE_ANALYTICS_TOKEN: state.token,
    EYE_ANALYTICS_NAMESPACE: namespace }, fixture.siteId, { windowMs: 7 * 86400000, graceMs: 3600000, attributionMs: 7 * 86400000 }, measured);
  let after = '', terminated = false; const samples = [];
  for (let page = 0; page < 10; page++) {
    const result = await source.page(original.from, original.until, after);
    samples.push(...result.cohort.samples);
    if (result.next === null) { terminated = true; break; }
    after = result.next;
  }
  const mismatches = samples.filter(s => !expected.has(s.sampleId) || Math.abs(s.reward - expected.get(s.sampleId)) > 1e-8).length;
  const actual = new Set(samples.map(s => s.sampleId));
  const duplicates = samples.length - actual.size, missing = [...expected.keys()].filter(key => !actual.has(key)).length;
  results[namespace] = { samples: samples.length, expected: expected.size, mismatches, duplicates, missing, terminated, queries };
  console.log(JSON.stringify({ namespace, ...results[namespace] }));
  if (samples.length !== expected.size || mismatches || duplicates || missing || !terminated) process.exitCode = 1;
}
await writeFile(join(directory, 'results/roll-learning.json'), JSON.stringify(results, null, 2));
