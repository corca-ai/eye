import { bindings, defineConfig, exports } from 'cf/config';
const prefix = process.env.EYE_LOAD_PREFIX ?? 'eye-load-20261023';
export default defineConfig({ ...(process.env.CLOUDFLARE_ACCOUNT_ID ? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID } : {}),
  worker: { name: `${prefix}-site`, entrypoint: './worker.ts', compatibilityDate: '2026-10-23',
    compatibilityFlags: ['nodejs_compat'], workersDev: true,
    observability: { enabled: true, headSamplingRate: 0.01 },
    exports: { Session: exports.durableObject({ storage: 'sqlite' }) },
    env: {
      EYE: bindings.worker({ worker: prefix }),
      SESSIONS: bindings.durableObject({ worker: `${prefix}-site`, exportName: 'Session' }),
      TEST_TOKEN: bindings.secret(), EYE_DECISION_SECRET: bindings.secret(),
    },
  },
});
