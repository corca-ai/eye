import { describe, expect, it } from 'vitest';
import { addSample, ageMoments, emptyMoments, meanOf, mergeMoments, stddevOf } from '../../src/core/moments.js';
import { settings } from '../../src/core/validation.js';

const config = settings({ minHoldMs: 0, learningHalfLifeMs: 1000 });
function samples(values: number[]) { return values.reduce((m, v) => addSample(m, v), emptyMoments(0)); }

describe('weighted moments', () => {
  it('forgets weight and variance mass together, while retaining the estimated mean', () => {
    const m = ageMoments(samples([-10, 0, 20]), 1000, 1000);
    expect(m.weight).toBe(1.5);
    expect(meanOf(m)).toBeCloseTo(10 / 3);
    expect(stddevOf(m)).toBeCloseTo(Math.sqrt(1400 / 9));
  });
  it('supports huge finite signed rewards without squaring them', () => {
    const m = samples([1e300, -1e300]);
    expect(meanOf(m)).toBe(0);
    expect(stddevOf(m)).toBe(1e300);

  });
  it('merges independent shard snapshots equivalently to a single stream', () => {
    const values = Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 1e6 + 1e9);
    const shards = Array.from({ length: 16 }, () => emptyMoments(0));
    values.forEach((v, i) => { shards[i % 16] = addSample(shards[i % 16]!, v); });
    const merged = shards.reduce(mergeMoments, emptyMoments(0));
    const direct = samples(values);
    expect(meanOf(merged) / meanOf(direct)).toBeCloseTo(1, 12);
    expect(stddevOf(merged) / stddevOf(direct)).toBeCloseTo(1, 10);
    expect(merged.weight).toBe(1000);
  });
});
