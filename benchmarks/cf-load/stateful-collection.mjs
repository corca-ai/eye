// Read-only reconciliation; rerun after pipeline visibility catches up, never reseed.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { literal } from '../../dist/analytics/sql.js';
const directory = dirname(fileURLToPath(import.meta.url));
if (!process.argv[2]) throw new Error('Pass a stateful run results directory');
const output = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(join(output, 'manifest.json')));
const state = JSON.parse(await readFile(join(directory, '.state/resources.json')));
const phases = manifest.phases.filter(p => p.mode === 'eye' && p.exitCode === 0);
if (!phases.length) throw new Error('No completed successful Eye phases');
const query = `SELECT json_get_str(attributes_json,'run') AS run,
json_get_str(payload_json,'kind') AS kind, experiment_id, arm_id,
CASE WHEN uid IS NULL THEN 'anonymous' ELSE 'authenticated' END AS identity,
COUNT(DISTINCT record_id) AS events, MIN(received_at) AS first_received, MAX(received_at) AS last_received
FROM eye.events WHERE site_id=${literal(manifest.site)}
GROUP BY json_get_str(attributes_json,'run'), json_get_str(payload_json,'kind'), experiment_id, arm_id,
CASE WHEN uid IS NULL THEN 'anonymous' ELSE 'authenticated' END
ORDER BY run,kind,experiment_id,arm_id,identity LIMIT 1000`;
const response = await fetch(`https://api.sql.cloudflarestorage.com/api/v1/accounts/${state.account}/basin-sql/query/${state.prefix}-data`, {
  method: 'POST', headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ warehouse: `${state.account}_${state.prefix}-data`, query }), signal: AbortSignal.timeout(60000),
});
const body = await response.json();
if (!response.ok || !body.result?.rows || body.result.rows.length >= 1000) throw new Error('Collection query failed or reached row limit');
const results = [];
for (const phase of phases) {
  const { metrics } = JSON.parse(await readFile(join(output, `${phase.run}.json`)));
  const rows = body.result.rows.filter(r => r.run === phase.run);
  const count = predicate => rows.filter(predicate).reduce((n, r) => n + r.events, 0);
  const comparisons = [{ dimension: 'all accepted submissions', expected: metrics.events_submitted.values.count, actual: count(() => true) }];
  for (const experiment of ['checkout', 'hero', 'pricing']) for (const arm of ['a', 'b', 'c']) {
    comparisons.push({ dimension: `${experiment}/${arm}`, expected: metrics[`eye_decisions{experiment:${experiment},arm:${arm}}`].values.count,
      actual: count(r => r.kind === 'exposure' && r.experiment_id === experiment && r.arm_id === arm) });
  }
  for (const identity of ['anonymous', 'authenticated']) comparisons.push({ dimension: identity,
    expected: metrics[`eye_skipped{identity:${identity}}`].values.fails,
    actual: count(r => r.kind === 'exposure' && r.identity === identity) });
  results.push({ run: phase.run, comparisons, matching: comparisons.every(c => c.expected === c.actual) });
}
const result = { observedAt: Date.now(), fullRunFinished: Boolean(manifest.endedAt), results,
  matching: results.every(r => r.matching), query, raw: body.result };
await writeFile(join(output, `collection-${result.observedAt}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ observedAt: result.observedAt, fullRunFinished: result.fullRunFinished, matching: result.matching, results }));
if (!result.matching) process.exitCode = 1;
