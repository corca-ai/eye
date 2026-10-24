import { performance } from 'node:perf_hooks';
import { addSample, emptyMoments } from '../dist/core/moments.js';
import { evaluateUnreservedPolicy, chooseArm } from '../dist/core/policy.js';
import { settings } from '../dist/core/validation.js';

const configuration = { ...settings({ minHoldMs: 0 }), bootstrapShare: 0.2 };
const iterations = 100_000;
for (const count of [2, 16, 64]) {
  const arms = Array.from({ length: count }, (_, i) => ({
    armId: String(i),
    moments: [0, 100, -20, 0, 5].reduce((m, value) => addSample(m, value + i), emptyMoments(0)),
  }));
  const run = () => chooseArm(evaluateUnreservedPolicy(arms, configuration, 86_400_000), 0.52);
  for (let i = 0; i < 10_000; i++) run();
  const batches = [];
  let checksum = 0;
  for (let batch = 0; batch < 100; batch++) {
    const start = performance.now();
    for (let i = 0; i < iterations / 100; i++) checksum += Number(run().armId);
    batches.push((performance.now() - start) * 1000 / (iterations / 100));
  }
  batches.sort((a, b) => a - b);
  console.log(JSON.stringify({ arms: count, iterations, microsecondsPerSelection: {
    medianBatch: batches[50], p95Batch: batches[95], mean: batches.reduce((s, n) => s + n, 0) / batches.length,
  }, checksum }));
}
