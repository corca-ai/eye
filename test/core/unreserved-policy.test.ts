import { describe, expect, it } from 'vitest';
import { addSample, ageMoments, emptyMoments } from '../../src/core/moments.js';
import { chooseArm, evaluateUnreservedPolicy } from '../../src/core/policy.js';
import { settings } from '../../src/core/validation.js';

const dayMs = 86_400_000;
const config = { ...settings({ minHoldMs: 0 }), bootstrapShare: 0.2 };
const observed = (n: number, reward: number, at = 0) => addSample(emptyMoments(at), reward, n);

describe('reservation-free optimistic policy', () => {
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
    expect(after.arms.find(a => a.armId === 'stale')!.probability).toBe(0.2);
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
