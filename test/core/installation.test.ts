import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { analyticsRecord } from '../../src/analytics/records.js';

const exec = promisify(execFile);
describe('installation artifacts', () => {
  it('keeps the structured Stream schema aligned with every exported field and its nullability', async () => {
    const schema: { fields: { name: string; type: string; required: boolean }[] } = JSON.parse(await readFile('templates/schema.json', 'utf8'));
    const sample = analyticsRecord({ siteId: 'site', subjectKey: 'subject' }, 'events', 'record', 1, 1000, 1001, {});
    expect(schema.fields.map(f => f.name).sort()).toEqual(Object.keys(sample).sort());
    for (const field of schema.fields) {
      const value = Reflect.get(sample, field.name);
      expect(field.required).toBe(value !== null);
      if (value !== null) expect(field.type).toBe(typeof value === 'number' ? 'int64' : 'string');
    }
    expect(schema.fields.find(f => f.name === 'value')?.type).toBe('float64');
  });
  it('generates an isolated installation, checkpoints provisioning and never overwrites a nonempty directory', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'eye-install-')), target = join(temporary, 'eye');
    try {
      const args = [resolve('scripts/eye.mjs'), 'init', target, '--account-id', 'a'.repeat(32), '--name', 'my-eye'];
      await exec(process.execPath, args);
      await expect(exec(process.execPath, args)).rejects.toThrow('must be empty');
      const initial = JSON.parse(await readFile(join(target, 'wrangler.jsonc'), 'utf8'));
      expect(initial.name).toBe('my-eye'); expect(initial.queues.consumers[0].dead_letter_queue).toBe('my-eye-events-failed');
      expect(initial.pipelines[0].stream).toBe('0'.repeat(32));
      // Fake only the external CLI boundary: no network calls or real credentials.
      const cli = join(temporary, 'node_modules/wrangler');
      await mkdir(join(cli, 'bin'), { recursive: true });
      await writeFile(join(cli, 'package.json'), '{"name":"wrangler","version":"4.151.3","type":"module"}');
      await writeFile(join(cli, 'bin/wrangler.js'), `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2); let input = '';
for await (const part of process.stdin) input += part;
appendFileSync('calls.jsonl', JSON.stringify({ args, input }) + '\\n');
if (args[0] === 'basin' && args[2] === 'sinks' && !existsSync('fail-once')) {
  writeFileSync('fail-once', '1'); console.error('token=' + process.env.EYE_CATALOG_TOKEN); process.exit(1);
}
if (args.includes('get')) console.log(JSON.stringify({ id: '${'b'.repeat(32)}' }));
`);
      const opts = { env: { ...process.env, EYE_CATALOG_TOKEN: 'catalog-secret-fixture', EYE_ANALYTICS_TOKEN: 'query-secret-fixture' } };
      try { await exec(process.execPath, [join(target, 'provision.mjs')], opts); throw new Error('Expected first sink to fail'); }
      catch (error) {
        expect(String(error)).toContain('[redacted]'); expect(String(error)).not.toContain('catalog-secret-fixture');
      }
      await exec(process.execPath, [join(target, 'provision.mjs')], opts);
      const final = JSON.parse(await readFile(join(target, 'wrangler.jsonc'), 'utf8'));
      expect(final.pipelines[0].stream).toBe('b'.repeat(32));
      const calls: { args: string[]; input: string }[] = (await readFile(join(target, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(calls.filter(c => c.args[0] === 'r2' && c.args.includes('create'))).toHaveLength(1);
      expect(calls.filter(c => c.args[2] === 'streams' && c.args[3] === 'create')).toHaveLength(1);
      const secret = calls.find(c => c.args[0] === 'secret');
      expect(JSON.parse(secret!.input)).toEqual({ EYE_ANALYTICS_TOKEN: 'query-secret-fixture' });
      expect(await readFile(join(target, '.provision-state.json'), 'utf8')).not.toContain('secret-fixture');
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
});
