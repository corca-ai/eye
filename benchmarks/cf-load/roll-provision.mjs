// Add a parallel 300-second test sink to the existing isolated benchmark stream.
// Existing 60-second sinks are preserved; no production resources are adopted.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const directory = dirname(fileURLToPath(import.meta.url));
const path = join(directory, '.state/resources.json');
const state = JSON.parse(await readFile(path));
if (!/^eye-i1-/.test(state.prefix)) throw new Error('Use the isolated issue-1 benchmark resources');
const stream = `${state.prefix.replaceAll('-', '_')}_stream`;
async function cf(args) {
  const child = spawn('cf', args, { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: state.account }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => errors += b);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  if (code !== 0) throw new Error((output + errors).replaceAll(state.token, '[redacted]'));
  return JSON.parse(output);
}
state.roll300 ??= {};
for (const table of ['events', 'identity_links']) {
  if (!state.roll300[table]) {
    state.roll300[table] = await cf(['pipelines', 'sinks', 'create', '--body', JSON.stringify({
      name: `${stream}_roll300_${table}`, type: 'r2_data_catalog', format: { type: 'parquet', compression: 'zstd' },
      config: { bucket: `${state.prefix}-data`, namespace: 'eye_roll300', table_name: table, token: state.token,
        rolling_policy: { interval_seconds: 300 } },
    })]);
    await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
    console.log(`Created test sink: ${table}`);
  }
}
if (!state.roll300.pipeline) {
  state.roll300.pipeline = await cf(['pipelines', 'create', '--name', `${stream}_roll300`, '--sql',
    ['events', 'identity_links'].map(table => `INSERT INTO ${stream}_roll300_${table} SELECT * FROM ${stream} WHERE table_name = '${table}';`).join('\n')]);
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log('Created parallel test pipeline');
}
