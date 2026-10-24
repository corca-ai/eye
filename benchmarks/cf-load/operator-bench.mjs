import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const { url } = JSON.parse(await readFile(join(directory, '.state/deployment.json')));
const { TEST_TOKEN } = JSON.parse(await readFile(join(directory, '.state/site-secrets.json')));
const fixture = JSON.parse(await readFile(join(directory, '.state/cohort-fixture.json')));
const base = `${url}/benchmark/jobs?site=${fixture.siteId}`;
const headers = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };
const request = { kind: 'goals', query: { from: Math.min(...fixture.events.map(e => e.occurredAt)), to: fixture.until, limit: 100 } };
async function call(path = '', body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers,
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Operator request HTTP ${response.status}`);
  return response.json();
}
const started = performance.now();
const [first, shared] = await Promise.all([call('', request), call('', request)]);
if (first.jobId !== shared.jobId) throw new Error('Concurrent identical queries did not coalesce');
const createMs = performance.now() - started;
let status;
for (let i = 0; i < 90; i++) {
  status = await call(`&jobId=${first.jobId}`);
  if (status.status === 'complete') break;
  if (status.status === 'failed' || status.status === 'cancelled') throw new Error(`Job ${status.status}: ${status.error}`);
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (status.status !== 'complete') throw new Error('Job did not finish within polling deadline');
const page = await call(`&jobId=${first.jobId}&page=1`);
const cached = await call('', request);
if (cached.jobId !== first.jobId || page.result.kind !== 'goals') throw new Error('Cached result mismatch');
const expectedEvents = fixture.events.filter(e => e.kind === 'goal').length;
const expectedValue = fixture.events.filter(e => e.kind === 'goal').reduce((sum, e) => sum + e.value, 0);
const row = page.result.data.rows[0];
if (row?.events !== expectedEvents || Math.abs(row.totalValue - expectedValue) > 1e-8) throw new Error('Goal aggregate differs from fixture');
const result = { createMs, elapsedMs: performance.now() - started, status, cached: true, expectedEvents, expectedValue, page };
await mkdir(join(directory, 'results'), { recursive: true });
await writeFile(join(directory, `results/operator-${Date.now()}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ createMs, elapsedMs: result.elapsedMs, cached: true, attempts: status.attempts, rows: page.result.data.rows.length, expectedEvents, bytesScanned: page.result.data.meta.bytesScanned }));
