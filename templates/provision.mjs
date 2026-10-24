// Run this file explicitly to create resources and deploy into your own Cloudflare account.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wrangler = join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
const configPath = join(directory, 'wrangler.jsonc'), statePath = join(directory, '.provision-state.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const resources = JSON.parse(await readFile(join(directory, 'resources.json'), 'utf8'));
// Existing generated installations retain their former 60-second setting.
const rollSeconds = resources.sinkRollIntervalSeconds ?? 60;
if (!Number.isSafeInteger(rollSeconds) || rollSeconds < 60 || rollSeconds > 300) throw new Error('sinkRollIntervalSeconds must be an integer from 60 to 300');
const catalogToken = process.env.EYE_CATALOG_TOKEN, queryToken = process.env.EYE_ANALYTICS_TOKEN;
if (!catalogToken || !queryToken) throw new Error('Set EYE_CATALOG_TOKEN and EYE_ANALYTICS_TOKEN before provisioning; values are never written to project files.');
let state = { completed: [] };
try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const identity = JSON.stringify({ account: config.account_id, name: config.name, resources });
if (state.identity && state.identity !== identity) throw new Error('Provisioning configuration changed. Use a fresh directory for a different installation.');
state.identity = identity;
async function save() {
  await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(`${statePath}.tmp`, statePath);
}
function redact(text) { return text.replaceAll(catalogToken, '[redacted]').replaceAll(queryToken, '[redacted]'); }
async function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args, '--config', configPath], {
      cwd: directory, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.account_id, CI: 'true', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', errors = '', exceeded = false;
    const collect = (target, chunk) => {
      if (output.length + errors.length + chunk.length > 8_000_000) { exceeded = true; child.kill(); return; }
      if (target === 'out') output += chunk; else errors += chunk;
    };
    child.stdout.on('data', chunk => collect('out', chunk)); child.stderr.on('data', chunk => collect('err', chunk));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0 && !exceeded) resolve(output);
      else reject(new Error(redact(`Wrangler failed (${code}). ${output}\n${errors}\nCheck the last resource in Cloudflare before retrying; a lost response can follow successful creation.`)));
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
async function step(key, args) {
  if (state.completed.includes(key)) return;
  console.log(`Creating ${key}…`);
  await run(args); state.completed.push(key); await save();
}
try {
  await step('bucket', ['r2', 'bucket', 'create', resources.bucket]);
  await step('catalog', ['basin', 'catalog', 'enable', resources.bucket]);
  await step('queue', ['queues', 'create', config.queues.producers[0].queue]);
  await step('dead-letter queue', ['queues', 'create', config.queues.consumers[0].dead_letter_queue]);
  if (!state.streamId) {
    await step('stream', ['basin', 'pipelines', 'streams', 'create', resources.streamName, '--schema-file', join(directory, 'schema.json'), '--http-enabled=false']);
    const stream = JSON.parse(await run(['basin', 'pipelines', 'streams', 'get', resources.streamName, '--json']));
    if (typeof stream.id !== 'string' || !/^[a-f0-9]{32}$/i.test(stream.id)) throw new Error('Wrangler returned an invalid Stream ID.');
    state.streamId = stream.id; await save();
  }
  for (const table of resources.tables) {
    // Wrangler 4.151 uses r2-data-catalog even though current prose docs also say basin-catalog.
    await step(`sink ${table}`, ['basin', 'pipelines', 'sinks', 'create', `${resources.streamName}_${table}`, '--type', 'r2-data-catalog',
      '--bucket', resources.bucket, '--namespace', resources.namespace, '--table', table, '--catalog-token', catalogToken, '--roll-interval', String(rollSeconds)]);
  }
  await step('pipeline', ['basin', 'pipelines', 'create', resources.pipelineName, '--sql-file', join(directory, 'fanout.sql')]);
  config.pipelines[0].stream = state.streamId;
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log('Deploying Eye Worker…');
  await run(['deploy']);
  await run(['secret', 'bulk'], JSON.stringify({ EYE_ANALYTICS_TOKEN: queryToken }));
  console.log(`Ready. Add a Service Binding named EYE for Worker ${config.name} to your application.`);
} catch (error) { console.error(redact(error instanceof Error ? error.message : 'Provisioning failed')); process.exitCode = 1; }
