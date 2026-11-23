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
let state = { completed: [] };
try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const identity = JSON.stringify({ account: config.account_id, name: config.name, queues: config.queues });
if (state.identity && state.identity !== identity) throw new Error('Provisioning configuration changed. Use a fresh directory for a different installation.');
state.identity = identity;
async function save() {
  await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(`${statePath}.tmp`, statePath);
}
async function run(args) {
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
      else reject(new Error(`Wrangler failed (${code}). ${output}\n${errors}\nCheck the last resource in Cloudflare before retrying; a lost response can follow successful creation.`));
    });
    child.stdin.on('error', () => {}); child.stdin.end();
  });
}
async function step(key, args) {
  if (state.completed.includes(key)) return;
  console.log(`Creating ${key}…`);
  await run(args); state.completed.push(key); await save();
}
try {
  await step('queue', ['queues', 'create', config.queues.producers[0].queue]);
  await step('dead-letter queue', ['queues', 'create', config.queues.consumers[0].dead_letter_queue]);
  console.log('Deploying Eye Worker…');
  await run(['deploy']);
  console.log(`Ready. Add a Service Binding named EYE for Worker ${config.name} to your application.`);
} catch (error) { console.error(error instanceof Error ? error.message : 'Provisioning failed'); process.exitCode = 1; }
