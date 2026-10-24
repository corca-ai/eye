import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BasinAnalytics } from '../../dist/analytics/query.js';
import { reduceClosedCohort } from '../../dist/core/closed-cohort.js';
const directory = dirname(fileURLToPath(import.meta.url));
const { url } = JSON.parse(await readFile(join(directory, '.state/deployment.json')));
const { TEST_TOKEN } = JSON.parse(await readFile(join(directory, '.state/site-secrets.json')));
const state = JSON.parse(await readFile(join(directory, '.state/resources.json')));
const fixture = JSON.parse(await readFile(join(directory, '.state/cohort-fixture.json')));
const headers = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };
async function call(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${url}${path}${path.includes('?') ? '&' : '?'}site=${fixture.siteId}`, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Benchmark HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
if (process.argv.includes('--publish')) {
  const result = await call(`/benchmark/learn?from=${fixture.from}&until=${fixture.until}&publish=1`, {});
  if (result.error) throw new Error(result.error);
  console.log(JSON.stringify({ published: result.pages.reduce((n, page) => n + page.records.length, 0) }));
} else {
  const api = new BasinAnalytics({ EYE_ANALYTICS_WAREHOUSE: `${state.account}_${state.prefix}-data`, EYE_ANALYTICS_TOKEN: state.token }, fixture.siteId);
  const range = { from: Math.min(...fixture.events.map(e => e.occurredAt)), to: fixture.until, limit: 1000 };
  const reference = reduceClosedCohort({ cohortId: 'expected', from: fixture.from, until: fixture.until, asOf: fixture.until,
    exposures: fixture.events.filter(e => e.kind === 'exposure').map(event => ({ event, ...event.sample, attributionWindowMs: event.attributionWindowMs })),
    goals: fixture.events.filter(e => e.kind === 'goal'), identities: fixture.events.filter(e => e.kind === 'identify' || e.kind === 'logout') });
  const frozen = await api.learning(range);
  await writeFile(join(directory, 'results/scheduled-learning-preflight.json'), JSON.stringify(frozen, null, 2));
  const visibleSamples = frozen.rows.reduce((n, row) => n + row.completed, 0);
  if (visibleSamples !== reference.samples.length) throw new Error(`Expected ${reference.samples.length} published samples, got ${visibleSamples}; inspect visibility before retrying`);
  const raw = await api.arms({ ...range, experimentId: 'exp-0' });
  const expected = reference.samples.reduce((n, sample) => n + sample.reward, 0);
  const schedules = [], results = {};
  try {
    for (const kind of ['learning', 'goals']) {
      const scheduleId = `benchmark-${kind}-${Date.now()}`;
      await call('/benchmark/schedules', { scheduleId, report: { kind }, windowMs: 28 * 86400000 });
      schedules.push(scheduleId);
      const deadline = Date.now() + 120000;
      let schedule;
      do {
        schedule = await call(`/benchmark/schedules?scheduleId=${scheduleId}`);
        if (schedule.latestJob) break;
        if (schedule.currentJob?.status === 'failed') throw new Error(`Scheduled ${kind} failed`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } while (Date.now() < deadline);
      if (!schedule.latestJob) throw new Error('Scheduled result deadline exceeded');
      const page = await call(`/benchmark/jobs?jobId=${schedule.latestJob.jobId}&page=1`);
      // Host's page route intentionally returns one row; retrieve the frozen result
      // through all offsets to test that pagination never schedules more SQL.
      const rows = [...page.result.data.rows]; let offset = page.nextOffset;
      while (offset !== null) {
        const next = await call(`/benchmark/jobs?jobId=${schedule.latestJob.jobId}&page=1&offset=${offset}`);
        rows.push(...next.result.data.rows); offset = next.nextOffset;
      }
      results[kind] = { schedule, request: page.request, meta: page.result.data.meta, rows };
      const same = await call('/benchmark/schedules', { scheduleId, report: { kind }, windowMs: 28 * 86400000 });
      if (same.latestJob?.jobId !== schedule.latestJob.jobId) throw new Error('Identical schedule registration regenerated a result');
    }
    const completed = results.learning.rows.reduce((n, row) => n + row.completed, 0);
    const reward = results.learning.rows.reduce((n, row) => n + row.learningValue, 0);
    const goals = results.goals.rows.reduce((n, row) => n + row.events, 0);
    const summary = { completed, expected: reference.samples.length, rewardMismatch: Math.abs(reward - expected), goals,
      frozenBytes: frozen.meta.bytesScanned, rawArmBytes: raw.meta.bytesScanned,
      attempts: Object.fromEntries(Object.entries(results).map(([key, value]) => [key, value.schedule.latestJob.attempts])) };
    await writeFile(join(directory, 'results/scheduled-report.json'), JSON.stringify({ summary, results }, null, 2));
    console.log(JSON.stringify(summary));
    if (completed !== reference.samples.length || Math.abs(reward - expected) > 1e-8 || goals !== fixture.events.filter(e => e.kind === 'goal').length) process.exitCode = 1;
  } finally {
    for (const scheduleId of schedules) await call(`/benchmark/schedules?scheduleId=${scheduleId}`, undefined, 'DELETE');
  }
}
