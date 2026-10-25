// Run with esbuild from the checkout; local SQLite, not Basin time or billing.
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { database } from '../../test/helpers/analytics-db.js';
import { hotSubjectStream, TEMPORAL_NOW as now, TEMPORAL_START as start } from '../../test/helpers/temporal-stream.js';
import { attributionCTEs } from '../../src/analytics/attribution-sql.js';
import { AnalyticsSQL } from '../../src/analytics/sql.js';
import { attributionCTEs as reference } from './reference-temporal-attribution.js';
import { AnalyticsSQL as ReferenceSQL } from './reference-scoped-sql.js';
function measure(run: () => unknown) {
  const times = [];
  for (let i = 0; i < 4; i++) { const at = performance.now(); run(); if (i) times.push(performance.now() - at); }
  return times.sort((a, b) => a - b)[1]!;
}
const hot = [], scoped = [];
for (const count of [80, 160, 320]) {
  const db = database(hotSubjectStream(count));
  try {
    const args = ['eye', "'site'", now - 60 * 86_400_000, start, now, now] as const;
    const before = reference(...args), after = attributionCTEs(...args);
    const credits = (ctes: string[]) => `WITH ${ctes.join(',')} SELECT * FROM credits_latest ORDER BY record_id`;
    assert.deepEqual(db.run(credits(after)), db.run(credits(before)));
    const candidates = (ctes: string[]) => db.run(`WITH ${ctes.join(',')} SELECT COUNT(*) AS n FROM ac_matches`)[0]!.n;
    hot.push({ events: count * 2, beforeCandidates: candidates(before), afterCandidates: candidates(after),
      beforeMs: measure(() => db.run(credits(before))), afterMs: measure(() => db.run(credits(after))) });
  } finally { db.close(); }
}
for (const unrelated of [0, 40, 160]) {
  const records = hotSubjectStream(30, unrelated), db = database(records);
  try {
    const next = new AnalyticsSQL('eye', 'site', now), old = new ReferenceSQL('eye', 'site', now);
    const timeline = { from: start, to: now, subject: { uid: 'u-0' }, includeLinked: false, limit: 100 } as const;
    const arms = { from: start, to: now, experimentId: 'exp' };
    const ctes = attributionCTEs('eye', "'site'", now - 60 * 86_400_000, start, now, now,
      { key: 'uid', value: "'u-0'", includeLinked: false });
    const work = db.run(`WITH ${ctes.join(',')} SELECT (SELECT COUNT(*) FROM ac_goals) AS goals,
(SELECT COUNT(*) FROM ac_exposures) AS exposures,(SELECT COUNT(*) FROM ac_matches) AS candidates`)[0];
    assert.deepEqual(db.run(next.timeline(timeline).sql), db.run(old.timeline(timeline).sql));
    assert.deepEqual(db.run(next.arms(arms).sql), db.run(old.arms(arms).sql));
    scoped.push({ unrelatedUsers: unrelated, events: records.length, ...work,
      timelineBeforeMs: measure(() => db.run(old.timeline(timeline).sql)), timelineAfterMs: measure(() => db.run(next.timeline(timeline).sql)),
      armsBeforeMs: measure(() => db.run(old.arms(arms).sql)), armsAfterMs: measure(() => db.run(next.arms(arms).sql)) });
  } finally { db.close(); }
}
console.log(JSON.stringify({ runtime: process.version, platform: process.platform,
  method: 'current SQL vs frozen 9db4e79; local memory SQLite, same immutable input, exact row equality, one warmup + three measured runs, median',
  limitations: 'Candidate counts are logical intermediate rows. Source reads still grow with total input; SQLite is not Basin EXPLAIN, scanned bytes, latency or billing.', hot, scoped }, null, 2));
