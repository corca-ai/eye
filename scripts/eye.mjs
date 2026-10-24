#!/usr/bin/env node
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    name: { type: 'string', default: 'eye' }, 'account-id': { type: 'string' }, bucket: { type: 'string' },
    namespace: { type: 'string', default: 'eye' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('eye init <directory> --account-id <32 hex characters> [--name eye] [--bucket eye-data] [--namespace eye]'); return;
  }
  const [command, directory] = positionals;
  if (command !== 'init' || !directory || positionals.length !== 2) throw new Error('Use eye init <directory> --account-id <account-id>');
  const name = values.name, account = values['account-id'], namespace = values.namespace, bucket = values.bucket ?? `${name}-data`;
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) throw new Error('name must start with a lowercase letter and contain at most 41 letters, digits, or hyphens');
  if (!account || !/^[a-f0-9]{32}$/i.test(account)) throw new Error('account-id must be 32 hexadecimal characters');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid R2 bucket name');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(namespace)) throw new Error('Invalid namespace');
  const target = resolve(directory);
  try { if ((await readdir(target)).length > 0) throw new Error('Target directory must be empty; existing files are never overwritten'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(target, { recursive: true });
  const template = JSON.parse(await readFile(join(root, 'templates/wrangler.json'), 'utf8'));
  template.name = name; template.account_id = account;
  template.queues.producers[0].queue = `${name}-events`;
  template.queues.consumers[0].queue = `${name}-events`;
  template.queues.consumers[0].dead_letter_queue = `${name}-events-failed`;
  template.r2_buckets = [{ binding: 'COHORTS', bucket_name: bucket }];
  template.vars = { EYE_ANALYTICS_WAREHOUSE: `${account}_${bucket}`, EYE_ANALYTICS_NAMESPACE: namespace };
  const streamName = `${name.replaceAll('-', '_')}_stream`;
  const tables = ['events', 'observations', 'credits', 'decisions', 'identity_links', 'policies', 'attribute_keys'];
  const outputs = {
    'wrangler.jsonc': JSON.stringify(template, null, 2) + '\n',
    'resources.json': JSON.stringify({ bucket, namespace, streamName, pipelineName: `${name.replaceAll('-', '_')}_pipeline`, tables }, null, 2) + '\n',
    'fanout.sql': tables.map(table => `INSERT INTO ${streamName}_${table}\nSELECT * FROM ${streamName} WHERE table_name = '${table}';`).join('\n\n') + '\n',
    '.gitignore': '.dev.vars\n.provision-state.json\n.wrangler/\n',
  };
  for (const name of ['worker.ts', 'schema.json', 'provision.mjs', 'README.md']) outputs[name] = await readFile(join(root, 'templates', name), 'utf8');
  for (const [name, contents] of Object.entries(outputs)) await writeFile(join(target, name), contents, { flag: 'wx' });
  console.log(`Created ${target}. No remote resources were created. Review README.md, then run node ${join(directory, 'provision.mjs')}.`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Initialization failed'); process.exitCode = 1; });
