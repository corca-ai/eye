import { mkdtemp, realpath, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
describe('installation artifacts', () => {
  it('generates an isolated installation, checkpoints provisioning and never overwrites a nonempty directory', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'eye-install-')), target = join(temporary, 'eye');
    try {
      const args = [resolve('scripts/eye.mjs'), 'init', target, '--account-id', 'a'.repeat(32), '--name', 'my-eye'];
      await exec(process.execPath, args);
      await expect(exec(process.execPath, args)).rejects.toThrow('must be empty');
      const initial = JSON.parse(await readFile(join(target, 'wrangler.jsonc'), 'utf8'));
      expect(initial.name).toBe('my-eye'); expect(initial.queues.consumers[0].dead_letter_queue).toBe('my-eye-events-failed');
      expect(initial.vars.EYE_INSTALLATION_ID).toMatch(/^[a-f0-9-]{36}$/);
      expect(initial.durable_objects.bindings).toEqual([{ name: 'SITES', class_name: 'SiteControl' }]);
      // Fake only the external CLI boundary: no network calls or real credentials.
      const cli = join(temporary, 'node_modules/wrangler');
      await mkdir(join(cli, 'bin'), { recursive: true });
      await writeFile(join(cli, 'package.json'), '{"name":"wrangler","version":"4.151.3","type":"module"}');
      await writeFile(join(cli, 'bin/wrangler.js'), `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2); let input = '';
for await (const part of process.stdin) input += part;
appendFileSync('calls.jsonl', JSON.stringify({ args, input }) + '\\n');
if (args[2] === 'my-eye-events-failed' && !existsSync('fail-once')) {
  writeFileSync('fail-once', '1'); console.error('temporary queue failure'); process.exit(1);
}
`);
      const provision = [join(target, 'provision.mjs')];
      await expect(exec(process.execPath, provision)).rejects.toThrow('temporary queue failure');
      await exec(process.execPath, provision);
      const calls: { args: string[] }[] = (await readFile(join(target, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(calls.map(c => c.args.slice(0, 3))).toEqual([
        ['queues', 'create', 'my-eye-events'],
        ['queues', 'create', 'my-eye-events-failed'],
        ['queues', 'create', 'my-eye-events-failed'],
        ['deploy', '--config', await realpath(join(target, 'wrangler.jsonc'))],
      ]);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
});
