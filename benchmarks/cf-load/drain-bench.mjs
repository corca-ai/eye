// Exercises the real scheduled SiteControl alarm on the existing dedicated cohort fixture.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { ageMoments } from '../../dist/core/moments.js';
import { reduceClosedCohort } from '../../dist/core/closed-cohort.js';
const base = new URL('./', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('.state/cohort-fixture.json', base)));
const { url } = JSON.parse(await readFile(new URL('.state/deployment.json', base)));
const { TEST_TOKEN } = JSON.parse(await readFile(new URL('.state/site-secrets.json', base)));
const headers = { Authorization: `Bearer ${TEST_TOKEN}` };
const reference = reduceClosedCohort({ cohortId: 'expected', from: fixture.from, until: fixture.until, asOf: fixture.until,
  exposures: fixture.events.filter(e => e.kind === 'exposure').map(event => ({ event, ...event.sample, attributionWindowMs: event.attributionWindowMs })),
  goals: fixture.events.filter(e => e.kind === 'goal'), identities: fixture.events.filter(e => e.kind === 'identify' || e.kind === 'logout') });
async function call(path, method = 'GET') {
  const response = await fetch(`${url}${path}&site=${fixture.siteId}`, { method, headers, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Benchmark HTTP ${response.status}`);
  return response.json();
}
await mkdir(new URL('results/', base), { recursive: true });
// Confirm data visibility before the once-only closing decision; don't drain an invisible fixture.
const preflight = await call(`/benchmark/learn?from=${fixture.from}&until=${fixture.until}`, 'POST');
const samples = preflight.pages?.flatMap(p => p.cohort.samples) ?? [];
const actual = new Map(samples.map(s => [s.sampleId, s.reward]));
if (preflight.error || samples.length !== reference.samples.length || reference.samples.some(s =>
  !actual.has(s.sampleId) || Math.abs(actual.get(s.sampleId) - s.reward) > 1e-8)) throw new Error('Fixture not fully visible; no alarm started');
const startedAt = Date.now(), target = Math.floor(startedAt / 3600000) * 3600000;
const output = { site: fixture.siteId, startedAt, from: fixture.from, target, preflightSamples: samples.length, observations: [] };
const path = new URL(`results/drain-${startedAt}.json`, base);
const save = () => writeFile(path, JSON.stringify(output, null, 2));
try {
  let result = await call(`/benchmark/drain?from=${fixture.from}`, 'POST');
  output.reusedInitialization = result.state.initializedAt < startedAt;
  do {
    output.observations.push({ at: Date.now(), ...result }); await save();
    if (result.state.from >= target && result.state.after === '' && result.state.alarmAt >= target + 3600000 && result.state.failures === 0) break;
    if (Date.now() - startedAt > 180000) throw new Error('Drain deadline exceeded; inspect/re-run status, do not reset cursor');
    await new Promise(resolve => setTimeout(resolve, 2000));
    result = await call('/benchmark/drain?status=1');
  } while (true);
  const mismatches = reference.arms.filter(a => {
    const policy = result.policies.find(p => p.experimentId === a.experimentId);
    const arm = policy?.arms.find(p => p.armId === a.armId);
    const settings = fixture.events.find(e => e.kind === 'exposure' && e.assignment.experimentId === a.experimentId && e.assignment.generation === a.generation)?.assignment.settings;
    if (!settings || !policy) return true;
    const expectedWeight = ageMoments(a.moments, policy.asOf, settings.learningHalfLifeMs).weight;
    return !Number.isFinite(arm?.weight) || Math.abs(arm.weight - expectedWeight) > 1e-8
      || !Number.isFinite(arm?.meanReward) || Math.abs(arm.meanReward - a.moments.mean * a.moments.scale) > 1e-8
      || policy.statsAsOf !== fixture.until;
  });
  output.endedAt = Date.now(); output.observationDurationMs = output.endedAt - startedAt;
  output.sinceInitializationMs = output.endedAt - result.state.initializedAt;
  output.mismatches = mismatches.length;
  output.complete = mismatches.length === 0 && output.observations.every(o => o.state.failures === 0)
    && result.state.alarmAt >= target + 3600000;
  await save(); console.log(JSON.stringify({ path: path.pathname, ...output, observations: output.observations.length }));
  if (!output.complete) process.exitCode = 1;
} catch (error) { output.error = String(error); await save(); throw error; }
