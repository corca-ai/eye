#!/usr/bin/env node
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    name: { type: 'string', default: 'eye' }, 'account-id': { type: 'string' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('eye init <directory> --account-id <32 hex characters> [--name eye]'); return;
  }
  const [command, directory] = positionals;
  if (command !== 'init' || !directory || positionals.length !== 2) throw new Error('Use eye init <directory> --account-id <account-id>');
  const name = values.name, account = values['account-id'];
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) throw new Error('name must start with a lowercase letter and contain at most 41 letters, digits, or hyphens');
  if (!account || !/^[a-f0-9]{32}$/i.test(account)) throw new Error('account-id must be 32 hexadecimal characters');
  const target = resolve(directory);
  try { if ((await readdir(target)).length > 0) throw new Error('Target directory must be empty; existing files are never overwritten'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(target, { recursive: true });
  const template = JSON.parse(await readFile(join(root, 'templates/wrangler.json'), 'utf8'));
  template.name = name; template.account_id = account;
  template.queues.producers[0].queue = `${name}-events`;
  template.queues.consumers[0].queue = `${name}-events`;
  template.queues.consumers[0].dead_letter_queue = `${name}-events-failed`;
  template.vars = { EYE_INSTALLATION_ID: randomUUID() };
  const outputs = {
    'wrangler.jsonc': JSON.stringify(template, null, 2) + '\n',
    '.gitignore': '.dev.vars\n.provision-state.json\n.wrangler/\n',
  };
  for (const name of ['worker.ts', 'provision.mjs', 'README.md']) outputs[name] = await readFile(join(root, 'templates', name), 'utf8');
  for (const [name, contents] of Object.entries(outputs)) await writeFile(join(target, name), contents, { flag: 'wx' });
  console.log(`Created ${target}. No remote resources were created. Review README.md, then run node ${join(directory, 'provision.mjs')}.`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Initialization failed'); process.exitCode = 1; });
