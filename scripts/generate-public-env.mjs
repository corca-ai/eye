import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const input = resolve('worker-configuration.d.ts');
const output = resolve('src/runtime/environment.generated.ts');
const source = await readFile(input, 'utf8');
const block = source.match(/interface __BaseEnv_Env \{([\s\S]*?)\n\}/);
if (!block) throw new Error('Cannot locate generated Wrangler binding interface; inspect the current generator format');
const body = block[1].replace(/(EYE_INSTALLATION_ID:) \"[^\"]*\";/, '$1 string;').replace(/import\("([^"]+)"\)/g, (_match, path) => {
  if (!path.startsWith('.')) return _match;
  const target = resolve(dirname(input), path);
  const fromOutput = relative(dirname(output), target).replaceAll('\\', '/');
  return `import(${JSON.stringify((fromOutput.startsWith('.') ? '' : './') + fromOutput + '.js')})`;
});
await writeFile(output, `// Generated from Wrangler types by scripts/generate-public-env.mjs. Do not edit.\nexport interface RuntimeEnv {${body}\n}\n`);
