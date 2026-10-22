import { describe, expect, it } from 'vitest';
import { addSample, ageMoments, emptyMoments, meanOf, mergeMoments, removeSample, replaceSample, stddevOf } from '../../src/core/moments.js';
import { chooseArm, evaluatePolicy } from '../../src/core/policy.js';
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
  it('revises late signed rewards at their original weight without adding a user', () => {
    const old = ageMoments(samples([10, 20, -3]), 2000, 1000);
    const corrected = replaceSample(old, 20, -40, 0.25);
    const expected = ageMoments(samples([10, -40, -3]), 2000, 1000);
    expect(corrected.weight).toBe(expected.weight);
    expect(meanOf(corrected)).toBeCloseTo(meanOf(expected));
    expect(stddevOf(corrected)).toBeCloseTo(stddevOf(expected));
  });
  it('supports huge finite signed rewards without squaring them', () => {
    const m = samples([1e300, -1e300]);
    expect(meanOf(m)).toBe(0);
    expect(stddevOf(m)).toBe(1e300);
    const corrected = replaceSample(m, -1e300, 1e300, 1);
    expect(meanOf(corrected)).toBe(1e300);
    expect(stddevOf(corrected)).toBe(0);
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
  it('can remove an interrupted completed sample and return to empty', () => {
    expect(removeSample(samples([123]), 123, 1).weight).toBe(0);
    expect(() => removeSample(samples([1]), 1, 2)).toThrow();
  });
});

describe('optimistic policy', () => {
  it('distributes cold-start traffic and includes exact mixture probabilities', () => {
    const e = evaluatePolicy([
      { armId: 'a', pending: 0, moments: emptyMoments(0) },
      { armId: 'b', pending: 1, moments: emptyMoments(0) },
    ], config, 0);
    expect(e.arms.map(a => a.probability)).toEqual([0.99, 0.01]);
    expect(chooseArm(e, 0.995)?.armId).toBe('b');
    expect(e.arms[1]?.weight).toBe(0);
  });
  it('increases uncertainty when an unobserved arm becomes stale', () => {
    const arms = [{ armId: 'a', pending: 0, moments: samples(Array(100).fill(1)) }];
    const now = evaluatePolicy(arms, config, 0);
    const later = evaluatePolicy(arms, config, 1000);
    expect(later.arms[0]!.score).toBeGreaterThan(now.arms[0]!.score);
    expect(later.arms[0]!.weight).toBe(50);
  });
  it('preserves preferences and probabilities when the value unit is changed', () => {
    const values = [[-20, 0, 100], [1, 30, -1]];
    const evaluate = (scale: number) => evaluatePolicy(values.map((v, i) => ({
      armId: String(i), pending: 8, moments: samples(v.map(x => x * scale)),
    })), { ...config, rewardScale: scale }, 500);
    const a = evaluate(1), b = evaluate(1e200);
    expect(a.arms.map(x => x.probability)).toEqual(b.arms.map(x => x.probability));
    expect(a.arms[0]!.score).toBeCloseTo(b.arms[0]!.score, 12);
  });
  it('normalizes probabilities across cold, observed and delayed arms', () => {
    for (let n = 1; n <= 100; n++) {
      const e = evaluatePolicy(Array.from({ length: n }, (_, i) => ({ armId: String(i), pending: i % 10, moments: samples(Array(i).fill(i - 50)) })), config, 100);
      expect(e.arms.reduce((sum, a) => sum + a.probability, 0)).toBeCloseTo(1, 12);
      for (const arm of e.arms) expect(arm.probability).toBeGreaterThanOrEqual(0.02 / n);
    }
  });
  it('returns no arm when there are no active arms', () => {
    expect(chooseArm(evaluatePolicy([], config, 0), 0.5)).toBeNull();
  });
});

describe('long-running changes', () => {
  it('adapts after nine months, including pending feedback and a serialized restart', () => {
    const dayMs = 86400000;
    const settings = { ...config, learningHalfLifeMs: 14 * dayMs };
    let state = [emptyMoments(0), emptyMoments(0)];
    const pending = [0, 0];
    const completions: { day: number; arm: number; reward: number }[] = [];
    let head = 0, seed = 123456789, optimal = 0, measured = 0;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    for (let day = 0; day < 540; day++) {
      const now = day * dayMs;
      state = state.map(m => ageMoments(m, now, settings.learningHalfLifeMs));
      while (head < completions.length && completions[head]!.day <= day) {
        const result = completions[head++]!;
        pending[result.arm]!--;
        state[result.arm] = addSample(state[result.arm]!, result.reward);
      }
      for (let i = 0; i < 20; i++) {
        const e = evaluatePolicy(state.map((moments, arm) => ({ armId: String(arm), moments, pending: pending[arm]! })), settings, now);
        const arm = Number(chooseArm(e, random())!.armId);
        const best = day < 270 ? 0 : 1;
        const reward = (arm === best ? 2 : 0.5) + random() - 0.5;
        completions.push({ day: day + 7, arm, reward });
        pending[arm]!++;
        if (day >= 284 && day < 314) { measured++; if (arm === best) optimal++; }
      }
      if (day === 180) state = JSON.parse(JSON.stringify(state)) as typeof state;
    }
    expect(optimal / measured).toBeGreaterThan(0.75);
  });

  it('retains tiny nonzero dispersion beside zero rewards', () => {
    const m = samples([0, 1e-300, -1e-300]);
    expect(meanOf(m)).toBe(0);
    expect(stddevOf(m) / 1e-300).toBeCloseTo(Math.sqrt(2 / 3), 12);
    const merged = mergeMoments(samples([0]), samples([1e-300, -1e-300]));
    expect(stddevOf(merged) / 1e-300).toBeCloseTo(Math.sqrt(2 / 3), 12);
  });
});
