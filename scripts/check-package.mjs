import { mkdtemp, mkdir, readFile, readdir, access, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile), root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'eye-package-'));
try {
  const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { cwd: root });
  const [{ filename, size }] = JSON.parse(stdout);
  const library = join(temporary, 'node_modules/@eye/workers');
  await mkdir(library, { recursive: true });
  await exec('tar', ['-xzf', join(temporary, filename), '--strip-components=1', '-C', library]);
  for (const file of await readdir(library, { recursive: true })) {
    if (!file.endsWith('.md')) continue;
    const markdown = await readFile(join(library, file), 'utf8');
    for (const [, target] of markdown.matchAll(/\]\(([^)]+)\)/g)) {
      if (!target.includes('://') && !target.startsWith('#')) {
        await access(join(library, dirname(file), target.split('#')[0]));
      }
    }
  }
  await symlink(join(root, 'node_modules/@cloudflare'), join(temporary, 'node_modules/@cloudflare'), 'dir');
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}');
  await writeFile(join(temporary, 'consumer.ts'), `
import { createEye, type EyeService, type ArmReport } from '@eye/workers';
declare const service: EyeService;
declare const ctx: ExecutionContext;
// The customer's Env need not match the library's generated runtime Env.
interface Env { MY_EYE_SERVICE: EyeService; OTHER_CONFIG: string }
const client = createEye({ service, ctx, siteId: 'consumer' });
const report: Promise<ArmReport> = client.analytics.arms({ from: 1, to: 2, experimentId: 'test' });
void report;
`);
  await writeFile(join(temporary, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2023'],
    types: ['@cloudflare/workers-types'], strict: true, exactOptionalPropertyTypes: true,
    skipLibCheck: false, noEmit: true,
  }, include: ['consumer.ts', 'node_modules/@eye/workers/examples/host.ts'] }));
  await exec(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(temporary, 'tsconfig.json')]);
  const installation = join(temporary, 'eye');
  await exec(process.execPath, [join(library, 'scripts/eye.mjs'), 'init', installation, '--account-id', 'a'.repeat(32)]);
  const deployed = await exec(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--dry-run', '--config', join(installation, 'wrangler.jsonc')]);
  const bundle = deployed.stdout.split('\n').find(line => line.includes('Total Upload:'));
  console.log(JSON.stringify({ tarballBytes: size, externalConsumerTypes: 'passed', generatedWorkerBundle: bundle?.trim() ?? 'passed', deployed: false }));
} finally { await rm(temporary, { recursive: true, force: true }); }
