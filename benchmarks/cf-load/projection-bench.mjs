import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyticsSQL } from '../../dist/analytics/sql.js';
import { rawRecords } from '../../dist/analytics/raw.js';
const directory = dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(await readFile(join(directory, '.state/resources.json')));
const original = JSON.parse(await readFile(join(directory, '.state/cohort-fixture.json')));
const fixture = { ...original, siteId: `${original.siteId}-projections` };
if (process.argv.includes('--seed')) {
  const { url } = JSON.parse(await readFile(join(directory, '.state/deployment.json')));
  const { TEST_TOKEN } = JSON.parse(await readFile(join(directory, '.state/site-secrets.json')));
  for (let i = 0; i < fixture.events.length; i += 100) {
    const response = await fetch(`${url}/benchmark/seed`, { method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture.events.slice(i, i + 100).map(event => ({ siteId: fixture.siteId, receivedAt: Date.now(), event }))),
      signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Seed HTTP ${response.status}`);
  }
  const records = fixture.events.flatMap(event => rawRecords({ siteId: fixture.siteId, receivedAt: Date.now(), event }));
  console.log(JSON.stringify({ seeded: fixture.events.length, projectionRows: records.filter(r => ['observations', 'decisions'].includes(r.table_name)).length }));
} else {
  const range = { from: Math.min(...fixture.events.map(e => e.occurredAt)), to: fixture.until, limit: 1000 };
  const api = new AnalyticsSQL('eye', fixture.siteId);
  const results = {};
  for (const [kind, plan] of [['arms', api.arms({ ...range, experimentId: 'exp-0' })],
    ['traffic', api.traffic({ ...range, experimentId: 'exp-0', bucketMs: 86400000 })],
    ['timeline', api.timeline({ ...range, subject: { uid: 'user-0' } })]]) {
    const response = await fetch(`https://api.sql.cloudflarestorage.com/api/v1/accounts/${state.account}/basin-sql/query/${state.prefix}-data`, {
      method: 'POST', headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ warehouse: `${state.account}_${state.prefix}-data`, query: plan.sql }), signal: AbortSignal.timeout(60000),
    });
    results[kind] = await response.json();
    if (!response.ok) throw new Error(`${kind}: ${JSON.stringify(results[kind].errors)}`);
  }
  const pending = results.arms.result.rows.reduce((n, r) => n + r.pending, 0);
  const assignments = results.traffic.result.rows.reduce((n, r) => n + r.assignments, 0);
  const exposures = results.traffic.result.rows.reduce((n, r) => n + r.exposures, 0);
  const timeline = results.timeline.result.rows;
  const observations = timeline.filter(r => r.table_name === 'observations').length;
  const decisions = timeline.filter(r => r.table_name === 'decisions').length;
  const summary = { pending, assignments, exposures, observations, decisions,
    metrics: Object.fromEntries(Object.entries(results).map(([key, value]) => [key, value.result.metrics])) };
  await writeFile(join(directory, 'results/projection-query.json'), JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify(summary));
  if (pending !== 100 || assignments !== 100 || exposures !== 300 || observations !== 3 || decisions !== 3) process.exitCode = 1;
}
