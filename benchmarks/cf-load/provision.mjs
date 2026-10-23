import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
const directory = dirname(fileURLToPath(import.meta.url));
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!account || !/^[a-f0-9]{32}$/i.test(account)) throw new Error('Set CLOUDFLARE_ACCOUNT_ID');
const prefix = process.env.EYE_LOAD_PREFIX ?? 'eye-load-20261023';
const stream = `${prefix.replaceAll('-', '_')}_stream`, bucket = `${prefix}-data`;
const stateDir = join(directory, '.state'); await mkdir(stateDir, { recursive: true });
let state = await readFile(join(stateDir, 'resources.json'), 'utf8').then(JSON.parse).catch(() => ({ account, prefix, completed: [] }));
if (state.account !== account || state.prefix !== prefix) throw new Error('Use a fresh state directory for different resources');
const save = () => writeFile(join(stateDir, 'resources.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
async function cf(args, cwd = directory) {
  const child = spawn('cf', args, { cwd, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account, ...(state.stream?.id ? { EYE_LOAD_STREAM_ID: state.stream.id } : {}) }, stdio: ['ignore','pipe','pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => errors += b);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  if (code !== 0) {
    const secret = state.token;
    throw new Error(`${args.slice(0, 3).join(' ')} failed (${code}): ${secret ? (output + errors).replaceAll(secret, '[redacted]') : output + errors}`);
  }
  return output;
}
async function step(name, args) {
  if (state.completed.includes(name)) return;
  console.log(`Provisioning ${name}`);
  const result = await cf(args);
  let parsed; try { parsed = JSON.parse(result); } catch { parsed = { output: result }; }
  state[name] = parsed; state.completed.push(name); await save();
}
// The caller can record a resource explicitly created before this script; never adopt unknown resources.
if (process.env.EYE_BUCKET_ALREADY_CREATED === '1' && !state.completed.includes('bucket')) {
  state.completed.push('bucket'); await save();
}
await step('bucket', ['r2','buckets','create','--name',bucket,'--location-hint','apac']);
await step('catalog', ['basin-catalog','enable',bucket]);
await step('queue', ['queues','create','--queue-name',`${prefix}-events`]);
await step('failed', ['queues','create','--queue-name',`${prefix}-failed`]);
if (!state.token) {
  const result = JSON.parse(await cf(['user','tokens','create','--name',`${prefix}-analytics`,
    '--expires-on', new Date(Date.now() + 3 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    '--policies', JSON.stringify([{ effect:'allow', resources:{ [`com.cloudflare.api.account.${account}`]:'*' },
      permission_groups:[{id:'d229766a2f7f4d299f20eaa8c9b1fde9'},{id:'f45430d92e2b4a6cb9f94f2594c141b8'},{id:'bf7481a1826f439697cb59a20b22293e'}] }]) ]));
  if (!result.value) throw new Error('Token response has no value');
  state.token = result.value; state.tokenId = result.id; await save();
}
const schema = JSON.parse(await readFile(join(directory, '../../templates/schema.json'), 'utf8'));
await step('stream', ['pipelines','streams','create','--name',stream, '--worker-binding-enabled', '--http-enabled=false', '--http-authentication',
  '--schema-fields',JSON.stringify(schema.fields), '--format-type','json']);
const tables = ['events','observations','credits','decisions','identity_links','policies','attribute_keys'];
for (const table of tables) await step(`sink_${table}`, ['pipelines','sinks','create', '--body', JSON.stringify({
  name: `${stream}_${table}`, type: 'r2_data_catalog', format: { type: 'parquet', compression: 'zstd' },
  config: { bucket, namespace: 'eye', table_name: table, token: state.token,
    rolling_policy: { interval_seconds: 60 } },
})]);
await step('pipeline', ['pipelines','create','--name',`${prefix.replaceAll('-', '_')}_pipeline`,
  '--sql', tables.map(t => `INSERT INTO ${stream}_${t} SELECT * FROM ${stream} WHERE table_name = '${t}';`).join('\n')]);
await writeFile(join(stateDir,'eye-secrets.json'),JSON.stringify({ EYE_ANALYTICS_TOKEN: state.token }),{mode:0o600});
try { await readFile(join(stateDir,'site-secrets.json')); } catch {
  await writeFile(join(stateDir,'site-secrets.json'),JSON.stringify({TEST_TOKEN:randomBytes(32).toString('hex'),EYE_DECISION_SECRET:randomBytes(32).toString('hex')}),{mode:0o600});
}
console.log('Deploying Eye');
console.log(await cf(['deploy','--secrets-file',join(stateDir,'eye-secrets.json')],join(directory,'eye')));
console.log('Deploying host');
const deployment = await cf(['deploy','--secrets-file',join(stateDir,'site-secrets.json')],join(directory,'site'));
console.log(deployment);
const url = deployment.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
if (!url) throw new Error('Inspect deployment output and record the host URL');
await writeFile(join(stateDir,'deployment.json'),JSON.stringify({url,account,prefix,createdAt:Date.now()},null,2),{mode:0o600});
