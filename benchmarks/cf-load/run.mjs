import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(await readFile(join(directory, '.state/deployment.json'), 'utf8'));
const secrets = JSON.parse(await readFile(join(directory, '.state/site-secrets.json'), 'utf8'));
const runId = `${new Date().toISOString().replaceAll(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const output = join(directory, 'results', runId);
await mkdir(output, { recursive: true });
const headers = { Authorization: `Bearer ${secrets.TEST_TOKEN}` };
const base = state.url;
const site = process.env.EYE_LOAD_SITE ?? `load-${runId}`;
const setup = await fetch(`${base}/setup?site=${site}`, { method: 'POST', headers });
if (!setup.ok) throw new Error(`Setup failed: ${setup.status} ${await setup.text()}`);
const start = Date.now();
await writeFile(join(output, 'manifest.json'), JSON.stringify({ start, runId, site, url: base, plan: 'paired baseline/eye 10,100,200 RPS for 5m, eye200 15m', region: 'local generator', users: 400, newFraction: 0.05 }, null, 2));
async function stage(mode, rate, duration, suffix, newFraction = 0.05) {
  const run = `${runId}-${mode}-${rate}-${suffix}`;
  console.log(JSON.stringify({ stage: run, rate, duration, at: new Date().toISOString() }));
  const child = spawn('k6', ['run', '--quiet', 'load.js'], { cwd: directory, env: { ...process.env,
    URL: base, TEST_TOKEN: secrets.TEST_TOKEN, MODE: mode, RATE: String(rate), DURATION: duration,
    RUN: run, SITE: site, POOL: process.env.EYE_LOAD_POOL ?? runId, NEW_FRACTION: String(newFraction), SUMMARY: join(output, `${run}.json`) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await writeFile(join(output, `${run}.log`), log);
  console.log(JSON.stringify({ stage: run, exitCode: code }));
  if (code !== 0) throw new Error(`Stage ${run} failed; inspect ${run}.log before continuing`);
}
if (process.env.EYE_LOAD_SKIP_WARMUP !== '1') await stage('eye', 10, '2m', 'warmup', 0);
for (const rate of [10, 100, 200]) {
  await stage('baseline', rate, '5m', 'measure');
  await stage('eye', rate, '5m', 'measure');
}
await stage('eye', 200, '15m', 'soak');
const report = await fetch(`${base}/report?site=${site}&from=${start}`, { headers });
await writeFile(join(output, 'report-initial.json'), await report.text());
console.log(JSON.stringify({ completed: true, output, endedAt: new Date().toISOString() }));
