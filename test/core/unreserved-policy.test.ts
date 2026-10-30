import { describe, expect, it } from 'vitest';
import { addSample, ageMoments, emptyMoments } from '../../src/core/moments.js';
import { chooseArm, evaluateUnreservedPolicy } from '../../src/core/policy.js';
import { settings } from '../../src/core/validation.js';

const dayMs = 86_400_000;
const config = { ...settings({ minHoldMs: 0 }), bootstrapShare: 0.2 };
const observed = (n: number, reward: number, at = 0) => addSample(emptyMoments(at), reward, n);

describe('optimistic policy for completed evidence', () => {
  it('caps all new arms together while rewards are delayed, without per-user counters', () => {
    const arms = [{ armId: 'established', moments: observed(100, 1) },
      ...Array.from({ length: 20 }, (_, i) => ({ armId: `new-${i}`, moments: emptyMoments(0) }))];
    for (let day = 0; day < 7; day++) {
      const policy = evaluateUnreservedPolicy(arms, config, day * dayMs);
      expect(policy.arms.filter(a => a.armId.startsWith('new-')).reduce((s, a) => s + a.probability, 0)).toBeCloseTo(0.2, 12);
      expect(policy.arms.find(a => a.armId === 'established')!.probability).toBeCloseTo(0.8, 12);
    }
  });

  it('starts uniformly and uses canonical arm order for deterministic draws', () => {
    const arms = ['z', 'a', 'c'].map(armId => ({ armId, moments: emptyMoments(0) }));
    const a = evaluateUnreservedPolicy(arms, config, 0);
    expect(a).toEqual(evaluateUnreservedPolicy([...arms].reverse(), config, 0));
    expect(a.arms.map(a => a.probability)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(chooseArm(a, 0)?.armId).toBe('a');
    expect(chooseArm(evaluateUnreservedPolicy([], config, 0), 0.5)).toBeNull();
  });

  it('decays evidence as well as reward mass and brings stale arms back to exploration', () => {
    const arms = [{ armId: 'stale', moments: observed(100, -10) }, { armId: 'recent', moments: observed(100, 2) }];
    const before = evaluateUnreservedPolicy(arms, config, 0);
    const now = 100 * dayMs;
    const after = evaluateUnreservedPolicy([arms[0]!, { armId: 'recent', moments: observed(100, 2, now) }], config, now);
    expect(after.arms.find(a => a.armId === 'stale')!.weight).toBeLessThan(config.bootstrapQuota);
    expect(after.arms.find(a => a.armId === 'stale')!.probability).toBeGreaterThan(0.17);
    expect(after.arms.find(a => a.armId === 'stale')!.probability).toBeLessThanOrEqual(0.2);
    expect(before.arms.find(a => a.armId === 'stale')!.probability).toBeLessThan(0.2);
  });

  it('keeps probabilities normalized and respects the floor, including full exploration', () => {
    for (const floor of [0.02, 0.8, 1]) for (let n = 1; n <= 30; n++) {
      const arms = Array.from({ length: n }, (_, i) => ({ armId: String(i), moments: observed(i, i - 20) }));
      const policy = evaluateUnreservedPolicy(arms, { ...config, explorationFloor: floor }, 0);
      expect(policy.arms.reduce((s, a) => s + a.probability, 0)).toBeCloseTo(1, 12);
      for (const arm of policy.arms) expect(arm.probability + 1e-15).toBeGreaterThanOrEqual(floor / n);
    }
  });

  it('preserves decisions across signed reward units and avoids raw reward squares', () => {
    const evaluate = (scale: number) => evaluateUnreservedPolicy([
      { armId: 'a', moments: observed(100, -2 * scale) },
      { armId: 'b', moments: observed(100, 3 * scale) },
    ], { ...config, rewardScale: scale }, 0);
    const reference = evaluate(1);
    for (const scale of [1e-300, 1e300]) {
      const policy = evaluate(scale);
      expect(policy.arms.map(a => a.probability)).toEqual(reference.arms.map(a => a.probability));
      policy.arms.forEach((arm, i) => expect(arm.score).toBeCloseTo(reference.arms[i]!.score, 12));
    }
  });

  it.each([123456789, 987654321, 13579])('adapts over 540 days with delayed rewards, added/removed arms and restart (seed %s)', initialSeed => {
    let seed = initialSeed;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    let state = [emptyMoments(0), emptyMoments(0), emptyMoments(0)];
    const completions: { at: number; arm: number; reward: number }[] = [];
    let head = 0;
    const counts = [0, 0, 0], totals = [0, 0, 0];
    for (let day = 0; day < 540; day++) {
      const now = day * dayMs;
      state = state.map(m => ageMoments(m, now, config.learningHalfLifeMs));
      while (head < completions.length && completions[head]!.at <= day) {
        const result = completions[head++]!;
        state[result.arm] = addSample(state[result.arm]!, result.reward);
      }
      const active = day < 360 ? [0, 1] : day < 450 ? [0, 1, 2] : [0, 1];
      const policy = evaluateUnreservedPolicy(active.map(arm => ({ armId: String(arm), moments: state[arm]! })), config, now);
      const best = day < 270 ? 0 : day < 360 ? 1 : day < 450 ? 2 : 0;
      for (let i = 0; i < 100; i++) {
        const arm = Number(chooseArm(policy, random())!.armId);
        expect(active).toContain(arm);
        completions.push({ at: day + 7, arm, reward: (arm === best ? 4 : -1) + random() - 0.5 });
        const period = day >= 310 && day < 350 ? 0 : day >= 410 && day < 450 ? 1 : day >= 500 ? 2 : -1;
        if (period >= 0) { totals[period]!++; if (arm === best) counts[period]!++; }
      }
      if (day === 180) state = JSON.parse(JSON.stringify(state)) as typeof state;
    }
    counts.forEach((n, i) => expect(n / totals[i]!).toBeGreaterThan(0.8));
  });
});

it('does not overflow an intermediate bonus when the final scaled score is finite', () => {
  const variable = addSample(addSample(emptyMoments(0), -1, 500_000), 1, 500_000);
  const policy = evaluateUnreservedPolicy([
    { armId: 'variable', moments: variable }, { armId: 'constant', moments: observed(100_000_000, 0) },
  ], { ...config, rewardScale: 0.01, bonusMultiplier: Number.MAX_VALUE }, 0);
  const score = policy.arms.find(arm => arm.armId === 'variable')!.score;
  expect(Number.isFinite(score)).toBe(true);
  const expected = Number.MAX_VALUE * (Math.sqrt(101) * Math.sqrt(Math.log(101_000_002) / 1_000_000));
  expect(score / expected).toBeCloseTo(1, 12);
  expect(JSON.parse(JSON.stringify(policy)).arms.every((arm: { score: unknown }) => typeof arm.score === 'number')).toBe(true);
});

it('uses sparse relative evidence even when no arm can ever reach the bootstrap quota', () => {
  let arms = [{ armId: 'bad', moments: emptyMoments(0) }, { armId: 'good', moments: emptyMoments(0) }];
  for (let day = 1; day <= 1000; day++) {
    arms = arms.map(a => ({ ...a, moments: ageMoments(a.moments, day * dayMs, config.learningHalfLifeMs) }));
    if (day % 4 === 0) arms = arms.map((a, i) => ({ ...a, moments: addSample(a.moments, i * 100) }));
  }
  const policy = evaluateUnreservedPolicy(arms, config, 1000 * dayMs);
  expect(policy.arms.every(a => a.weight < config.bootstrapQuota)).toBe(true);
  expect(policy.arms.find(a => a.armId === 'good')!.probability).toBeGreaterThan(0.8);
  const first = evaluateUnreservedPolicy([{ armId: 'a', moments: observed(1, 1000) },
    { armId: 'b', moments: emptyMoments(0) }], config, 0);
  expect(Math.max(...first.arms.map(a => a.probability))).toBeLessThan(0.6);
  const stale = evaluateUnreservedPolicy(arms, config, 1100 * dayMs);
  expect(Math.max(...stale.arms.map(a => a.probability))).toBeLessThan(0.51);
});

it('returns unused bootstrap protection to warm winners, while allowing promising cold contenders', () => {
  const warm = { armId: 'warm', moments: observed(1000, 100) };
  const bad = evaluateUnreservedPolicy([warm, { armId: 'cold', moments: observed(7, -100) }], config, 0);
  expect(bad.arms.find(a => a.armId === 'cold')!.probability).toBeCloseTo(0.03375, 12);
  expect(bad.arms.find(a => a.armId === 'warm')!.probability).toBeCloseTo(0.96625, 12);
  const good = evaluateUnreservedPolicy([warm, { armId: 'cold', moments: observed(7, 1000) }], config, 0);
  expect(good.arms.find(a => a.armId === 'cold')!.probability).toBeCloseTo(0.2, 12);
  const unseen = evaluateUnreservedPolicy([warm, { armId: 'cold', moments: emptyMoments(0) }], config, 0);
  expect(unseen.arms.find(a => a.armId === 'cold')!.probability).toBeCloseTo(0.2, 12);
});

it('handles quota boundaries, shared score ties and an exploration floor above the nominal cold cap', () => {
  for (const weight of [0, 1, 7.999999, 8, 8.000001]) {
    for (const floor of [0.02, 0.8, 1]) {
      const policy = evaluateUnreservedPolicy([
        { armId: 'a', moments: observed(weight, -1) }, { armId: 'b', moments: observed(7.9, 1) },
        { armId: 'c', moments: emptyMoments(0) },
      ], { ...config, explorationFloor: floor }, 0);
      expect(policy.arms.reduce((sum, a) => sum + a.probability, 0)).toBeCloseTo(1, 12);
      for (const a of policy.arms) expect(a.probability).toBeGreaterThanOrEqual(floor / 3 - 1e-15);
      if (weight >= 8) {
        const cap = Math.max(floor * 2 / 3, config.bootstrapShare);
        expect(policy.arms.filter(a => a.weight < 8).reduce((sum, a) => sum + a.probability, 0)).toBeLessThanOrEqual(cap + 1e-15);
      }
    }
  }
  // A negligible bonus gives exact equal scores across warm/cold groups.
  const ties = evaluateUnreservedPolicy([
    { armId: 'warm', moments: observed(1000, 100) },
    { armId: 'cold-a', moments: observed(7, 100) }, { armId: 'cold-b', moments: observed(7, 100) },
  ], { ...config, bonusMultiplier: Number.MIN_VALUE }, 0);
  expect(ties.arms.every(a => a.score === 1)).toBe(true);
  expect(ties.arms.find(a => a.armId === 'warm')!.probability).toBeCloseTo(.8, 12);
  expect(ties.arms.find(a => a.armId === 'cold-a')!.probability).toBeCloseTo(.1, 12);
  expect(ties.arms.find(a => a.armId === 'cold-b')!.probability).toBeCloseTo(.1, 12);
});
