import { bindings, defineConfig, exports, triggers } from 'cf/config';
const prefix = process.env.EYE_LOAD_PREFIX ?? 'eye-load-20261023';
const classes = ['SiteControl', 'ExperimentObject', 'ReportObject'];
const names = ['SITES', 'EXPERIMENTS', 'REPORTS'];
export default defineConfig({ ...(process.env.CLOUDFLARE_ACCOUNT_ID ? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID } : {}),
  worker: { name: prefix, entrypoint: './worker.ts', compatibilityDate: '2026-10-23',
    compatibilityFlags: ['nodejs_compat'], workersDev: false,
    observability: { enabled: true, headSamplingRate: 1, logs: { enabled: true, invocationLogs: false } },
    exports: Object.fromEntries(classes.map(name => [name, exports.durableObject({ storage: 'sqlite' })])),
    env: {
      ...Object.fromEntries(classes.map((exportName, i) => [names[i], bindings.durableObject({ worker: prefix, exportName })])),
      COHORTS: bindings.r2({ name: `${prefix}-data` }),
      EVENTS: bindings.queue({ name: `${prefix}-events` }),
      ANALYTICS: bindings.pipeline({ name: process.env.EYE_LOAD_STREAM_ID ?? '0'.repeat(32) }),
      EYE_ANALYTICS_WAREHOUSE: bindings.text(`${process.env.CLOUDFLARE_ACCOUNT_ID ?? '0'.repeat(32)}_${prefix}-data`),
      EYE_ANALYTICS_NAMESPACE: bindings.text('eye'),
      EYE_ANALYTICS_TOKEN: bindings.secret(),
    },
    triggers: [triggers.queue({ name: `${prefix}-events`, maxBatchSize: 100,
      maxBatchTimeout: 1, maxRetries: 5, deadLetterQueue: `${prefix}-failed` })],
  },
});
