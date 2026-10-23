import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const base = new URL('./', import.meta.url);
const { url } = JSON.parse(await readFile(new URL('.state/deployment.json', base)));
const { TEST_TOKEN } = JSON.parse(await readFile(new URL('.state/site-secrets.json', base)));
const label = process.argv[2] ?? 'prepare';
if (!/^[a-z0-9_-]+$/i.test(label)) throw new Error('Invalid label');
const site = `${label}-${Date.now()}-${randomUUID().slice(0, 6)}`;
const output = new URL(`results/${site}/`, base);
await mkdir(output, { recursive: true });
const headers = { Authorization: `Bearer ${TEST_TOKEN}` };
const setup = await fetch(`${url}/setup?site=${site}&profile=long`, { method: 'POST', headers });
if (!setup.ok) throw new Error(`setup ${setup.status}`);
const rounds = [];
for (let round = 0; round < 3; round++) {
  const measurements = [];
  let cursor = 0;
  const started = performance.now();
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= 24) return;
      const start = performance.now();
      let status = 0, tokens = 0;
      try {
        const response = await fetch(`${url}/prepare?site=${site}`, { method: 'POST', headers: { ...headers, 'X-Session-ID': `${site}-${i}`, 'X-Authenticated': i % 2 ? '0' : '1' }, signal: AbortSignal.timeout(30000) });
        status = response.status;
        if (response.ok) tokens = Object.values((await response.json()).tokens).filter(x => typeof x === 'string').length;
      } catch { /* timeouts remain failures */ }
      measurements.push({ i, authenticated: i % 2 === 0, ms: performance.now() - start, status, tokens });
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  const sorted = measurements.map(x => x.ms).sort((a, b) => a - b);
  const summary = { round, kind: round ? 'warm' : 'cold', elapsedMs: performance.now() - started,
    complete: measurements.filter(x => x.status === 200 && x.tokens === 3).length,
    p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], measurements };
  rounds.push(summary);
  console.log(JSON.stringify({ ...summary, measurements: undefined }));
  await writeFile(new URL('prepare.json', output), JSON.stringify({ site, label, concurrency: 4, sessions: 24, rounds }, null, 2));
}
console.log(JSON.stringify({ output: output.pathname }));
