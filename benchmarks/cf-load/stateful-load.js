// Each VU owns one returning user and carries post-exposure state forward.
// No preparer/proxy or session DO is used on the measured request path.
import http from 'k6/http';
import encoding from 'k6/encoding';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
const skipped = new Rate('eye_skipped');
const decisions = new Counter('eye_decisions');
const localMs = new Trend('eye_local_ms', true);
const churn = new Counter('state_churn');
const contractErrors = new Counter('contract_errors');
const submitted = new Counter('events_submitted');
const rejected = new Counter('events_rejected');
const tokenBytes = new Trend('state_header_bytes');
const rate = Number(__ENV.RATE || 10), run = __ENV.RUN, mode = __ENV.MODE || 'eye';
const experiments = ['checkout', 'hero', 'pricing'];
export const options = {
  scenarios: { requests: { executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration: __ENV.DURATION || '5m',
    preAllocatedVUs: Math.max(30, rate), maxVUs: Math.max(100, rate * 4), gracefulStop: '15s' } },
  thresholds: { http_req_failed: ['rate<0.01'], checks: ['rate==1'], dropped_iterations: ['count==0'],
    contract_errors: ['count==0'], events_rejected: ['count==0'], state_churn: ['count==0'],
    ...Object.fromEntries(['new', 'returning'].flatMap(cohort => [
      [`http_req_duration{cohort:${cohort}}`, []], [`eye_skipped{cohort:${cohort}}`, []],
      [`eye_local_ms{cohort:${cohort}}`, []],
    ])),
    ...Object.fromEntries(experiments.flatMap(experiment => ['a', 'b', 'c'].map(arm =>
      [`eye_decisions{experiment:${experiment},arm:${arm}}`, []]))),
    ...Object.fromEntries(['anonymous', 'authenticated'].map(identity => [`eye_skipped{identity:${identity}}`, []])),
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};
let tokens = {}, seen = false;
function hash(n) { n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); return (n ^ (n >>> 16)) >>> 0; }
function context(token) { return JSON.parse(encoding.b64decode(token.split('.')[0], 'rawurl', 's')).context; }
export default function () {
  const i = exec.scenario.iterationInTest;
  const fresh = hash(i + 117) % 100 < 5;
  const id = fresh ? `${run}-new-${i}` : `${run}-vu-${__VU}`;
  const authenticated = (fresh ? i : __VU) % 2 === 0;
  const tags = { mode, cohort: fresh || !seen ? 'new' : 'returning', identity: authenticated ? 'authenticated' : 'anonymous' };
  const sent = fresh ? {} : tokens;
  const goalDraw = hash(i + 91251) % 100;
  const goal = goalDraw === 0 ? 'refund' : goalDraw === 1 ? 'signup' : goalDraw < 12 ? 'purchase' : '';
  const header = JSON.stringify(sent); tokenBytes.add(header.length);
  const response = http.get(`${__ENV.URL}/fast-page?mode=${mode}&site=${__ENV.SITE}&run=${run}`, {
    headers: { Authorization: `Bearer ${__ENV.TEST_TOKEN}`, 'X-Request-ID': `${run}-${i}`, 'X-Session-ID': id,
      'X-Authenticated': authenticated ? '1' : '0', 'X-Goal': goal, 'X-Eye-Tokens': header },
    timeout: '10s', responseCallback: http.expectedStatuses(200), tags: { ...tags, name: 'fast-page' },
  });
  // Transport failures have their own HTTP error-rate threshold; contracts apply to received 200 responses.
  if (response.status !== 200) return;
  contractErrors.add(0);
  try {
    const data = response.json();
    check(data, { 'bounded equal response size': () => response.body.length === 8192,
      'state supplied': d => d.tokens && typeof d.tokens === 'object',
      'three decisions': d => d.metrics.length === (mode === 'eye' ? 3 : 0) });
    localMs.add(data.eyeMs, tags); submitted.add(data.submitted); rejected.add(data.rejected); churn.add(0);
    for (const experimentId of Object.keys(sent)) {
      if (!data.tokens[experimentId]) churn.add(1);
    }
    for (const metric of data.metrics) {
      const next = data.tokens[metric.experimentId];
      const nextContext = next ? context(next) : undefined;
      decisions.add(1, { ...tags, experiment: metric.experimentId, outcome: metric.outcome, reason: metric.reason,
        arm: metric.outcome === 'assigned' ? nextContext?.assignment.armId || 'missing' : 'none' });
      skipped.add(metric.outcome !== 'assigned', tags);
      if (metric.outcome === 'assigned') check(nextContext, { 'assigned state contains sample': c => Boolean(c?.sample) });
      if (sent[metric.experimentId] && next) {
        const previous = context(sent[metric.experimentId]);
        // Setup uses day-long hold / seven-day sample; neither should change in this run.
        if (previous.assignment.assignmentId !== nextContext.assignment.assignmentId
          || previous.sample?.sampleId !== nextContext.sample?.sampleId) churn.add(1);
      }
    }
    if (!fresh) { tokens = data.tokens; seen = true; }
  } catch { contractErrors.add(1); }
}
export function handleSummary(data) { return { [__ENV.SUMMARY]: JSON.stringify(data, null, 2) }; }
