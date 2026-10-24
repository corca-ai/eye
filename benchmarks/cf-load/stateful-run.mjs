import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const { url } = JSON.parse(await readFile(join(directory, '.state/deployment.json')));
const { TEST_TOKEN } = JSON.parse(await readFile(join(directory, '.state/site-secrets.json')));
const id = `stateful-${Date.now()}-${randomUUID().slice(0, 8)}`;
const output = join(directory, 'results', id);
await mkdir(output, { recursive: true });
const smoke = process.argv.includes('--smoke'), interleaved = process.argv.includes('--interleaved');
const rateIndex = process.argv.indexOf('--rate'), eyeOnly = process.argv.includes('--eye-only');
const rates = rateIndex < 0 ? [10, 100, 200] : [Number(process.argv[rateIndex + 1])];
if (rates.some(rate => ![10, 100, 200].includes(rate)) || (eyeOnly && rateIndex < 0) || (interleaved && (eyeOnly || rateIndex >= 0))) throw new Error('Use --rate 10|100|200 with optional --eye-only, separately from --interleaved');
const manifest = { id, site: id, url, startedAt: Date.now(), profile: 'long', responseBytes: 8192,
  newUserFraction: interleaved ? 0 : 0.05, comparison: interleaved ? 'interleaved, equal state headers' : eyeOnly ? 'Eye-only diagnostic' : 'sequential', returningUsers: 'one per VU', phases: [] };
const save = () => writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
await save();
const setup = await fetch(`${url}/setup?site=${id}&profile=long`, { method: 'POST', headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
if (!setup.ok) throw new Error(`Setup failed: HTTP ${setup.status}`);
async function stage(mode, rate, duration, label) {
  const run = `${id}-${label}-${mode}-${rate}`;
  const phase = { run, mode, rate, duration, startedAt: Date.now() };
  manifest.phases.push(phase); await save();
  console.log(JSON.stringify(phase));
  const child = spawn('k6', ['run', '--quiet', interleaved ? 'interleaved-load.js' : 'stateful-load.js'], { cwd: directory,
    env: { ...process.env, URL: url, TEST_TOKEN, MODE: mode, RATE: String(rate), DURATION: duration,
      RUN: run, SITE: id, SUMMARY: join(output, `${run}.json`) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await writeFile(join(output, `${run}.log`), log);
  Object.assign(phase, { endedAt: Date.now(), exitCode: code }); await save();
  console.log(JSON.stringify(phase));
  if (code !== 0) throw new Error(`Stage failed; inspect ${output}`);
}
if (interleaved) {
  await stage('interleaved', smoke ? 10 : 200, smoke ? '45s' : '5m30s', 'measure');
} else {
  await stage('eye', 10, smoke ? '15s' : '1m', 'warmup');
  for (const rate of smoke ? [10] : rates) {
    if (!eyeOnly) await stage('baseline', rate, smoke ? '15s' : '5m', 'measure');
    await stage('eye', rate, smoke ? '15s' : '5m', 'measure');
  }
}
manifest.endedAt = Date.now(); await save();
console.log(JSON.stringify({ completed: true, output }));
