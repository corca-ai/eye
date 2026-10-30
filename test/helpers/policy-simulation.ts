import { addSample, ageMoments, decayFactor, emptyMoments } from '../../src/core/moments.js';
import { chooseArm, evaluateUnreservedPolicy, type UnreservedPolicySettings } from '../../src/core/policy.js';
import { settings } from '../../src/core/validation.js';

const DAY = 86_400_000;
export type Scenario = 'sparse' | 'poor-newcomer' | 'jackpot' | 'delayed' | 'reversal';
export const scenarios: readonly Scenario[] = ['sparse', 'poor-newcomer', 'jackpot', 'delayed', 'reversal'];
const randomFor = (seed: number) => {
  const next = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  // Adjacent small seeds otherwise all make the same first allocation.
  for (let i = 0; i < 8; i++) next();
  return next;
};

/** Frozen pre-change allocation, reusing only the unchanged moment score calculation.
 * This is a comparison oracle, not a second production policy. */
function legacyAllocation(evaluation: ReturnType<typeof evaluateUnreservedPolicy>, config: UnreservedPolicySettings) {
  const { arms } = evaluation, cold = arms.filter(a => a.weight < config.bootstrapQuota);
  const warm = arms.filter(a => a.weight >= config.bootstrapQuota);
  if (!warm.length) return { arms: arms.map(a => ({ ...a, probability: 1 / arms.length })) };
  const floor = config.explorationFloor / arms.length;
  const coldMass = cold.length ? Math.max(floor * cold.length, Math.min(config.bootstrapShare, cold.length / arms.length)) : 0;
  const best = Math.max(...warm.map(a => a.score)), winners = warm.filter(a => a.score === best);
  const surplus = Math.max(0, 1 - coldMass - floor * warm.length);
  return { arms: arms.map(a => ({ ...a, probability: a.weight < config.bootstrapQuota ? coldMass / cold.length
    : floor + (a.score === best ? surplus / winners.length : 0) })) };
}

export function simulatePolicy(scenario: Scenario, seed: number, legacy: boolean) {
  const config = { ...settings({ minHoldMs: 0 }), bootstrapShare: 0.2 };
  const draw = randomFor(seed), outcome = randomFor(seed ^ 0x5f3759df);
  const interval = scenario === 'sparse' ? 4 * DAY : DAY / 4;
  const duration = (scenario === 'sparse' ? 1600 : 400) * DAY;
  const delay = (scenario === 'delayed' ? 21 : 7) * DAY;
  let state = [emptyMoments(0), emptyMoments(0)];
  if (scenario === 'poor-newcomer') state = [addSample(state[0]!, 100, 1000), addSample(state[1]!, -100, 7)];
  const pending: { endAt: number; arm: number; reward: number }[] = [];
  let head = 0, expected = 0, realized = 0, oracle = 0, lateBest = 0, lateVisits = 0;
  for (let at = 0; at < duration; at += interval) {
    state = state.map(m => ageMoments(m, at, config.learningHalfLifeMs));
    while (head < pending.length && pending[head]!.endAt <= at) {
      const sample = pending[head++]!;
      state[sample.arm] = addSample(state[sample.arm]!, sample.reward,
        decayFactor(at - sample.endAt, config.learningHalfLifeMs));
    }
    const evaluation = evaluateUnreservedPolicy(state.map((moments, arm) => ({ armId: String(arm), moments })), config, at);
    const policy: Pick<typeof evaluation, 'arms'> = legacy ? legacyAllocation(evaluation, config) : evaluation;
    const probability = policy.arms.reduce((sum, a) => sum + a.probability, 0);
    if (Math.abs(probability - 1) > 1e-12 || policy.arms.some(a => !Number.isFinite(a.probability) || a.probability < .01 - 1e-15))
      throw new Error('Invalid simulation policy');
    const means = scenario === 'poor-newcomer' ? [100, -100] : scenario === 'jackpot' ? [.5, 1]
      : scenario === 'reversal' && at < duration / 2 ? [1, 0] : [0, 1];
    // Generate both counterfactual rewards before choosing; the learner sees only
    // the selected result after completion. Outcome/draw streams are independent.
    const rewards = means.map((mean, arm) => scenario === 'jackpot' && arm === 1
      ? (outcome() < .05 ? 20 : 0) : mean! + (outcome() - .5) * .2);
    const arm = Number(chooseArm(policy, draw())!.armId);
    expected += means[arm]!; realized += rewards[arm]!; oracle += Math.max(...means);
    pending.push({ endAt: at + delay, arm, reward: rewards[arm]! });
    if (at >= duration * .75) { lateVisits++; if (means[arm] === Math.max(...means)) lateBest++; }
  }
  return { expectedFraction: expected / oracle, realizedFraction: realized / oracle, lateBestShare: lateBest / lateVisits };
}
