import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'core', include: ['test/core/**/*.test.ts'], environment: 'node' } },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, miniflare: { bindings: { EYE_ANALYTICS_WAREHOUSE: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_eye-test', EYE_ANALYTICS_TOKEN: 'local-test-only' } } })],
        test: { name: 'workers', include: ['test/runtime/**/*.test.ts'] },
      },
    ],
  },
});
