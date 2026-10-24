import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const directory = dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(await readFile(join(directory, '.state/resources.json')));
const fixture = JSON.parse(await readFile(join(directory, '.state/roll-fixture.json')));
const start = fixture.rounds[0].startedAt, results = {};
for (const namespace of ['eye', 'eye_roll300']) {
  const child = spawn('cf', ['basin-catalog', 'namespaces', 'tables', 'get', 'events', '--bucket-name', `${state.prefix}-data`, '--namespace', namespace], {
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: state.account }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', error = '';
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => error += b);
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  if (status !== 0) throw new Error(error.replaceAll(state.token, '[redacted]'));
  const table = JSON.parse(output), snapshots = table.metadata.snapshots ?? [];
  const interval = snapshots.filter(s => s['timestamp-ms'] >= start);
  const appended = interval.filter(s => s.summary.operation === 'append');
  results[namespace] = { table, summary: {
    completeHistory: table.returned_snapshots === table.total_snapshots || Math.min(...snapshots.map(s => s['timestamp-ms'])) <= start,
    appendSnapshots: appended.length, addedFiles: appended.reduce((n, s) => n + Number(s.summary['added-data-files']), 0),
    addedRecords: appended.reduce((n, s) => n + Number(s.summary['added-records']), 0),
    addedBytes: appended.reduce((n, s) => n + Number(s.summary['added-files-size']), 0),
  } };
}
await writeFile(join(directory, `results/roll-snapshots-${Date.now()}.json`), JSON.stringify({ fixture, results }, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([key, value]) => [key, value.summary]))));
