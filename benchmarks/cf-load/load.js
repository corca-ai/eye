import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

const decisions = new Counter('eye_decisions');
const skipped = new Rate('eye_skipped');
const localMs = new Trend('eye_local_ms', true);
const sessionMs = new Trend('session_ms', true);
const submitted = new Counter('events_submitted');
const rejected = new Counter('events_rejected');
const rate = Number(__ENV.RATE || 10);
const run = __ENV.RUN || 'smoke';
const mode = __ENV.MODE || 'eye';
const site = __ENV.SITE || 'load';
const users = Number(__ENV.USERS || 400);
const newFraction = Number(__ENV.NEW_FRACTION || 0.05);
export const options = {
  scenarios: { requests: { executor: 'constant-arrival-rate', rate, timeUnit: '1s',
    duration: __ENV.DURATION || '5m', preAllocatedVUs: Math.max(30, rate), maxVUs: Math.max(100, rate * 4), gracefulStop: '15s' } },
  thresholds: { http_req_failed: ['rate<0.01'], checks: ['rate>0.99'], dropped_iterations: ['count==0'], events_rejected: ['count==0'],
    'http_req_duration{cohort:new}': [], 'http_req_duration{cohort:returning}': [],
    'eye_skipped{cohort:new}': [], 'eye_skipped{cohort:returning}': [],
    ...Object.fromEntries(['cold', 'expired', 'unprepared', 'invalid_state', 'inactive', 'fresh', 'stale'].map(reason => [`eye_decisions{reason:${reason}}`, []])),
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};
function hash(n) { n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); return (n ^ (n >>> 16)) >>> 0; }
export default function () {
  const i = exec.scenario.iterationInTest;
  const fresh = hash(i + 117) % 10000 < newFraction * 10000;
  const id = fresh ? `${run}-new-${i}` : `${__ENV.POOL || 'warm'}-${i % users}`;
  const authenticated = i % users % 2 === 0;
  const goalDraw = hash(i + 91251) % 100;
  const goal = goalDraw === 0 ? 'refund' : goalDraw === 1 ? 'signup' : goalDraw < 12 ? 'purchase' : '';
  const response = http.get(`${__ENV.URL}/${__ENV.ENDPOINT || 'page'}?mode=${mode}&site=${site}&run=${run}`, {
    headers: { Authorization: `Bearer ${__ENV.TEST_TOKEN}`, 'X-Request-ID': `${run}-${i}`,
      'X-Session-ID': id, 'X-Authenticated': authenticated ? '1' : '0', 'X-Goal': goal },
    timeout: '10s', tags: { name: 'page', mode, cohort: fresh ? 'new' : 'returning' },
  });
  const ok = check(response, { 'status 200': r => r.status === 200 });
  if (!ok) return;
  const data = response.json();
  localMs.add(data.eyeMs, { cohort: fresh ? 'new' : 'returning' });
  sessionMs.add(data.sessionMs);
  submitted.add(data.submitted);
  rejected.add(data.rejected);
  for (const m of data.metrics) {
    const tags = { reason: m.reason, experiment: m.experimentId, cohort: fresh ? 'new' : 'returning' };
    decisions.add(1, { ...tags, outcome: m.outcome });
    if (m.outcome !== 'no_active_arm') skipped.add(m.outcome === 'skipped', tags);
  }
}
export function handleSummary(data) { return { [__ENV.SUMMARY || `results/${run}.json`]: JSON.stringify(data, null, 2) }; }
