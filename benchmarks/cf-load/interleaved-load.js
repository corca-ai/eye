// A latency diagnostic: both modes carry the same existing state header.
// Run separately from the full collection-quality workload.
import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
const errors = new Counter('contract_errors');
const skipped = new Rate('eye_skipped');
const measured = new Counter('measured_requests');
const experiments = ['checkout', 'hero', 'pricing'];
const rate = Number(__ENV.RATE || 200);
export const options = {
  scenarios: { requests: { executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration: __ENV.DURATION || '5m30s',
    preAllocatedVUs: Math.max(30, rate), maxVUs: Math.max(100, rate * 4), gracefulStop: '15s' } },
  thresholds: { http_req_failed: ['rate<0.01'], checks: ['rate==1'], dropped_iterations: ['count==0'], contract_errors: ['count==0'],
    ...Object.fromEntries(['baseline', 'eye'].flatMap(mode => ['http_req_duration', 'http_req_waiting'].map(metric => [`${metric}{mode:${mode},phase:measure}`, []]))),
    'eye_skipped{phase:measure}': ['rate<0.01'],
    'measured_requests{mode:eye}': ['count>0'], 'measured_requests{mode:baseline}': ['count>0'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};
let tokens = {}, established = false;
function hash(n) { n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); return (n ^ (n >>> 16)) >>> 0; }
export default function () {
  const i = exec.scenario.iterationInTest;
  const ready = established && experiments.every(id => typeof tokens[id] === 'string');
  const phase = ready && Date.now() - exec.scenario.startTime >= 30000 ? 'measure' : 'warmup';
  const mode = phase === 'warmup' || hash(i + 67129) % 2 === 0 ? 'eye' : 'baseline';
  const draw = hash(i + 91251) % 100;
  const goal = draw === 0 ? 'refund' : draw === 1 ? 'signup' : draw < 12 ? 'purchase' : '';
  const response = http.get(`${__ENV.URL}/fast-page?mode=${mode}&site=${__ENV.SITE}&run=${__ENV.RUN}`, {
    headers: { Authorization: `Bearer ${__ENV.TEST_TOKEN}`, 'X-Request-ID': `${__ENV.RUN}-${i}`, 'X-Session-ID': `${__ENV.RUN}-vu-${__VU}`,
      'X-Authenticated': __VU % 2 === 0 ? '1' : '0', 'X-Goal': goal, 'X-Eye-Tokens': JSON.stringify(tokens) },
    timeout: '10s', responseCallback: http.expectedStatuses(200), tags: { name: 'fast-page', mode, phase },
  });
  measured.add(phase === 'measure' ? 1 : 0, { mode });
  // Transport failures have their own HTTP error-rate threshold; contracts apply to received 200 responses.
  if (response.status !== 200) return;
  errors.add(0);
  try {
    const data = response.json();
    check(data, { 'equal response size': () => response.body.length === 8192, 'no rejected events': d => d.rejected === 0,
      'correct decisions': d => d.metrics.length === (mode === 'eye' ? 3 : 0),
      'state present': d => d.tokens && typeof d.tokens === 'object' && !Array.isArray(d.tokens),
      'returning state preserved': d => Object.keys(tokens).every(key => typeof d.tokens[key] === 'string') });
    for (const metric of data.metrics) skipped.add(metric.outcome !== 'assigned', { phase });
    tokens = data.tokens;
    if (mode === 'eye' && experiments.every(id => typeof tokens[id] === 'string'
      && data.metrics.some(m => m.experimentId === id && m.outcome === 'assigned'))) established = true;
  } catch { errors.add(1); }
}
export function handleSummary(data) { return { [__ENV.SUMMARY]: JSON.stringify(data, null, 2) }; }
