// npm run build; node benchmarks/sdk/performance.mjs [absolute dist directory]
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
const base = pathToFileURL(resolve(process.argv[2] ?? 'dist') + '/');
const { decisionRuntime, DecisionCache } = await import(new URL('decisions.js', base));
const { createEye } = await import(new URL('client.js', base));
const { packEvents } = await import(new URL('runtime/queue-batch.js', base));
const { settings } = await import(new URL('core/validation.js', base));
const secret = 'benchmark-secret-at-least-32-bytes-long';
function fixture(latency = 0) {
  let calls = 0, writes = 0;
  const pending = [], config = settings({ minHoldMs: 3600000 });
  const service = { async getPublishedPolicy(_, experimentId) {
    calls++;
    if (latency) await new Promise(resolve => setTimeout(resolve, latency));
    return { experimentId, generation: 1, revision: 1, sequence: 1, settings: config,
      publishedAt: Date.now(), status: 'active', activeArms: ['a'], asOf: Date.now(), statsAsOf: null, scoreScale: 1,
      arms: [{ armId: 'a', probability: 1, score: 1, weight: 1, meanReward: 1 }] };
  } };
  const cache = new DecisionCache(), ctx = { waitUntil: p => pending.push(p) };
  return { service, cache, ctx, pending, counts: () => ({ policyRPCs: calls, stateWrites: writes }),
    runtime: () => decisionRuntime(service, ctx, 'site', { secret, cache, onPrepared: () => { writes++; } }, error => { throw error; }) };
}
const repeatTimings = [];
for (let run = 0; run < 4; run++) {
  const f = fixture(), runtime = f.runtime();
  const p = await runtime.prepare({ cid: 'c' }, 'exp');
  const start = performance.now();
  for (let i = 0; i < 1000; i++) runtime.expose(p.decision, Date.now(), 'event-' + i);
  await runtime.state(); await Promise.all(f.pending);
  if (run) repeatTimings.push(performance.now() - start);
  if (run === 3) console.log(JSON.stringify({ workload: '1000 repeated exposures', ...f.counts(), elapsedMs: repeatTimings }));
}
const prepareTimings = [];
for (let run = 0; run < 4; run++) {
  const f = fixture(2), runtime = f.runtime();
  await runtime.prepare({ cid: 'c' }, 'exp');
  const start = performance.now();
  for (let i = 0; i < 50; i++) await runtime.prepare({ cid: 'c' }, 'exp');
  await Promise.all(f.pending);
  if (run) prepareTimings.push(performance.now() - start);
  if (run === 3) console.log(JSON.stringify({ workload: '50 warm prepares; simulated 2ms RPC', ...f.counts(), elapsedMs: prepareTimings }));
}
{
  const f = fixture(2);
  await Promise.all(Array.from({ length: 20 }, (_, i) => f.runtime().prepare({ cid: 'c' + i }, 'exp')));
  await Promise.all(f.pending);
  console.log(JSON.stringify({ workload: '20 concurrent cold prepares', ...f.counts() }));
}
{
  let calls = 0, messages = 0, events = 0;
  const pending = [], service = { async ingest(batch) { calls++; messages += packEvents(batch).length; events += batch.length; } };
  for (let i = 0; i < 100; i++) {
    const eye = createEye({ service, siteId: 'site', ctx: { waitUntil: p => pending.push(p) } });
    for (let j = 0; j < 5; j++) { eye.track({ subject: { cid: 'c' + i }, name: 'view', eventId: i + ':' + j }); await Promise.resolve(); }
    await eye.flush();
  }
  await Promise.all(pending);
  console.log(JSON.stringify({ workload: '100 requests x 5 events separated by microtasks', ingestCalls: calls, queueMessages: messages, events }));
}
