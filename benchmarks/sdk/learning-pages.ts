// Bundle with esbuild for Node, then run. Local SQLite execution is not Basin billing evidence.
import { performance } from 'node:perf_hooks';
import { database } from '../../test/helpers/analytics-db.js';
import { LearningSource } from './legacy-learning.js';
import { rawRecords } from '../../src/analytics/raw.js';
import { settings } from '../../src/core/validation.js';
import type { EyeEvent } from '../../src/core/types.js';
const now = 1_800_000_000_000, start = now - 3000;
const config = settings({ minHoldMs: 0, observationWindowMs: 1000, allowedLatenessMs: 10 });
const events: EyeEvent[] = [];
for (let i = 0; i < 2001; i++) {
  const subject = { cid: String(i) }, sampleId = String(i).padStart(5, '0');
  events.push({ kind: 'exposure', eventId: 'e-' + sampleId, occurredAt: start, subject,
    assignment: { assignmentId: sampleId, experimentId: 'exp', armId: i % 2 ? 'a' : 'b',
      generation: 1, assignedAt: start, policyRevision: 1, probability: .5, settings: config },
    sample: { sampleId, startAt: start }, attributionWindowMs: 1000 });
  if (i % 500 === 0) events.push({ kind: 'goal', eventId: 'g-' + sampleId, occurredAt: start + 100,
    subject, goalId: 'value', value: i % 40 ? -20 : 100 });
}
const db = database(events.flatMap(event => rawRecords({ siteId: 'site', receivedAt: now - 1, event })));
const env = { EYE_ANALYTICS_WAREHOUSE: 'a'.repeat(32) + '_eye-data', EYE_ANALYTICS_TOKEN: 'test' };
let reference: string | undefined;
try {
  for (const limit of [1000, 2000, 5000]) {
    const timings: number[] = [];
    let queries = 0, maxBytes = 0;
    for (let run = 0; run < 3; run++) {
      const source = new LearningSource(env, 'site', { windowMs: 1000, graceMs: 10, attributionMs: 1000 }, db.request, () => now);
      let after: string | null = '', count = 0;
      const values: [string, number][] = [];
      maxBytes = 0;
      const begin = performance.now();
      do {
        const page = await source.page(now - 2100, now - 1000, after, limit);
        count++;
        maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(page)));
        values.push(...page.cohort.samples.map(s => [s.sampleId, s.reward] as [string, number]));
        after = page.next;
      } while (after !== null);
      timings.push(performance.now() - begin); queries = count;
      const actual = JSON.stringify(values);
      reference ??= actual;
      if (actual !== reference || values.length !== 2001) throw new Error('Changed learning results');
    }
    console.log(JSON.stringify({ limit, queries, samples: 2001, maxFrozenResultBytes: maxBytes, elapsedMs: timings }));
  }
} finally { db.close(); }
