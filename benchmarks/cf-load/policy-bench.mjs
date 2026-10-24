import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const { url } = JSON.parse(await readFile(join(directory, '.state/deployment.json')));
const { TEST_TOKEN } = JSON.parse(await readFile(join(directory, '.state/site-secrets.json')));
await mkdir(join(directory, 'results'), { recursive: true });
const site = `policy-${crypto.randomUUID()}`, startedAt = Date.now();
const response = await fetch(`${url}/benchmark/policy?site=${site}`, { method: 'POST',
  headers: { Authorization: `Bearer ${TEST_TOKEN}` }, signal: AbortSignal.timeout(60000) });
const result = await response.json();
const complete = response.ok && result.cold === 'unavailable' && result.staleArm === result.firstArm
  && ['a', 'b'].includes(result.refreshedArm) && result.refreshedArm !== result.firstArm
  && result.expired === 'unavailable' && result.reads >= 3
  && result.errors.some(error => error.includes('injected policy outage'));
const output = { site, startedAt, endedAt: Date.now(), status: response.status, complete, result };
await writeFile(join(directory, `results/policy-${startedAt}.json`), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output));
if (!complete) process.exitCode = 1;
