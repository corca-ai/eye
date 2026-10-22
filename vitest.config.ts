import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'core', include: ['test/core/**/*.test.ts'], environment: 'node' } },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
        test: { name: 'workers', include: ['test/runtime/**/*.test.ts'] },
      },
    ],
  },
});
