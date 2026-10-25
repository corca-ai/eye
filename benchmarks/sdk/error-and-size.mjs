// npm run build; node benchmarks/sdk/error-and-size.mjs [absolute dist directory]
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
const base = pathToFileURL(resolve(process.argv[2] ?? 'dist') + '/');
const { createEye, encodedSize, MAX_EVENT_BYTES, MAX_BATCH_BYTES } = await import(new URL('client.js', base));
const { createEyeRequest } = await import(new URL('request.js', base));
const { packEvents, packIngestion } = await import(new URL('runtime/queue-batch.js', base));
const { parseEnvelope } = await import(new URL('core/events.js', base));
const { invariant } = await import(new URL('core/errors.js', base));
const median = values => values.sort((a, b) => a - b)[2];
const results = [], subject = { cid: 'browser' };
for (const mode of ['raw', 'wrapper-no-hook', 'wrapper-counter-hook']) {
  const samples = []; let last;
  for (let pass = 0; pass < 6; pass++) {
    const pending = [], ctx = { waitUntil: promise => pending.push(promise) };
    let rejected = 0, reported = 0, delivered = 0;
    const service = { async ingest(batch) { delivered += batch.length; } };
    const start = performance.now();
    for (let request = 0; request < 100; request++) {
      const options = { service, ctx, siteId: 'site', collectionLimits: { maxEvents: 1 } };
      const eye = mode === 'raw' ? createEye(options) : createEyeRequest({ ...options, subject,
        ...(mode === 'wrapper-counter-hook' ? { onError: () => reported++ } : {}) });
      const input = mode === 'raw' ? { subject, name: 'view' } : { name: 'view' };
      assert.equal(eye.track(input).accepted, true);
      for (let i = 0; i < 200; i++) if (!eye.track(input).accepted) rejected++;
    }
    const ms = (performance.now() - start) / 100;
    await new Promise(resolve => setTimeout(resolve, 0)); await Promise.all(pending);
    assert.equal(delivered, 100); assert.equal(rejected, 20_000);
    assert.equal(reported, mode === 'wrapper-counter-hook' ? 20_000 : 0);
    if (pass) samples.push(ms);
    last = { acceptedPerRequest: 1, rejectedPerRequest: 200, reportsPerRequest: reported / 100 };
  }
  results.push({ name: mode, ...last, medianSynchronousRequestAverageMs: median(samples) });
}
const now = Date.now();
const legacyPack = envelopes => {
  const sizes = envelopes.map(event => encodedSize(event) + 200);
  invariant(sizes.every(size => size <= MAX_EVENT_BYTES) && sizes.reduce((sum, size) => sum + size, 0) <= MAX_BATCH_BYTES,
    'invalid_input', 'Ingestion batch exceeds encoded size limits');
  return packEvents(envelopes);
};
for (const [count, detail] of [[1, 'view'], [50, 'view'], [2, '한'.repeat(20_000)]]) {
  const inputs = Array.from({ length: count }, (_, i) => ({ siteId: 'site', receivedAt: now,
    event: { kind: 'track', eventId: String(i), occurredAt: now, subject, name: 'view', attributes: { detail } } }));
  const expected = packEvents(inputs.map(input => parseEnvelope(input, now)));
  const samples = []; let actual;
  for (let pass = 0; pass < 6; pass++) {
    const start = performance.now();
    for (let i = 0; i < 300; i++) {
      const envelopes = inputs.map(input => parseEnvelope(input, now));
      actual = (packIngestion ?? legacyPack)(envelopes);
    }
    if (pass) samples.push((performance.now() - start) / 300);
    assert.deepEqual(actual, expected);
  }
  results.push({ name: `ingest-${count}-events-${detail.length}-chars`, events: count,
    queueMessages: actual.length, samePackets: true, medianBatchAverageMs: median(samples) });
}
console.log(JSON.stringify({ node: process.version, platform: process.platform,
  method: 'one warmup + five measured passes; median of averages; mocked delivery and local ingestion parse/validation/packing; not Workers latency', results }, null, 2));
