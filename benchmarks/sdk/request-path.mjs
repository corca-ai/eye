// npm run build; node benchmarks/sdk/request-path.mjs
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
const { createEye } = await import(new URL('client.js', pathToFileURL(resolve('dist') + '/')));
const subject = { cid: 'browser' }, small = { path: '/checkout', device: 'mobile' };
const results = [];
async function measure(name, requests, events, attributes, collectionLimits) {
  const samples = []; let last;
  for (let pass = 0; pass < 6; pass++) {
    const pending = [], ctx = { waitUntil: promise => pending.push(promise) };
    let accepted = 0, rejected = 0, delivered = 0;
    const service = { async ingest(batch) { delivered += batch.length; } };
    const start = performance.now();
    for (let request = 0; request < requests; request++) {
      const eye = createEye({ service, ctx, siteId: 'site', ...(collectionLimits ? { collectionLimits } : {}) });
      for (let event = 0; event < events; event++) {
        const result = eye.track({ subject, name: 'view', attributes });
        if (result.accepted) accepted++; else rejected++;
      }
    }
    const ms = (performance.now() - start) / requests;
    await new Promise(resolve => setTimeout(resolve, 0));
    await Promise.all(pending);
    if (accepted !== delivered) throw new Error('Accepted events must be delivered');
    last = { acceptedPerRequest: accepted / requests, rejectedPerRequest: rejected / requests };
    if (pass) samples.push(ms);
  }
  samples.sort((a, b) => a - b);
  results.push({ name, requestsPerPass: requests, eventsPerRequest: events, ...last, medianRequestAverageMs: samples[2] });
}
await measure('small event', 1000, 1, small);
await measure('five small events', 1000, 5, small);
await measure('100 small events', 100, 100, small);
await measure('64KB string', 300, 1, { payload: 'x'.repeat(64_000) });
await measure('oversized string', 100, 1, { payload: 'x'.repeat(1_000_000) });
await measure('exhausted request: maxEvents=20', 100, 1000, small, { maxEvents: 20 });
console.log(JSON.stringify({ node: process.version, platform: process.platform,
  method: 'one warmup and five measured passes; median of synchronous request averages; mocked ingestion, not Workers latency', results }, null, 2));
