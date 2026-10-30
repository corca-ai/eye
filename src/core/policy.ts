import { invariant } from './errors.js';
import { compareIdentifiers } from './attribution.js';
import { ageMoments, emptyMoments, meanOf, mergeMoments, stddevOf } from './moments.js';
import type { Moments } from './moments.js';
import type { ExperimentSettings } from './types.js';

export interface PolicyArm {
  readonly armId: string;
  readonly moments: Readonly<Moments>;
}
export interface ArmEvaluation {
  readonly armId: string;
  /** 시간 감쇠된 완료 표본 가중치 합. 정수 사용자 수가 아니다. */
  readonly weight: number;
  /** 원래 가치 단위의 감쇠 평균. 해당 arm 자료가 없으면 전체 arm의 평균(전체도 없으면 0). */
  readonly meanReward: number;
  /** Compare scores in shared scoreScale units to avoid raw-score overflow. */
  readonly score: number;
  /** 현재 신규 선택의 확률. 기존 배정 유지 요청의 실제 노출 비율과 다르다. */
  readonly probability: number;
}
export interface PolicyEvaluation {
  readonly scoreScale: number;
  /** 통계를 함께 비교한 기준 Unix 밀리초. 내부 DO 시각 차이 때문에 응답자의 벽시계보다 앞설 수 있다. */
  readonly asOf: number;
  readonly arms: readonly ArmEvaluation[];
}

type ScoreSettings = Pick<ExperimentSettings, 'learningHalfLifeMs' | 'rewardScale' | 'bonusMultiplier'>;
function scoreArms(arms: readonly PolicyArm[], settings: ScoreSettings, now: number) {
  const aged = arms.map(a => {
    return { ...a, moments: ageMoments(a.moments, now, settings.learningHalfLifeMs) };
  });
  let pooled = emptyMoments(now);
  for (const arm of aged) pooled = mergeMoments(pooled, arm.moments);
  const scale = Math.max(settings.rewardScale, stddevOf(pooled));
  const pooledMean = meanOf(pooled);
  const means = aged.map(a => a.moments.weight > 1e-12 ? meanOf(a.moments) : pooledMean);
  // Include means so even rewards near Number.MAX_VALUE can be ranked safely.
  const scoreScale = Math.max(scale, ...means.map(Math.abs));
  const logMass = Math.log(2 + pooled.weight);
  const scored = aged.map((a, i) => {
    const sd = a.moments.weight > 1e-12 ? stddevOf(a.moments) : scale;
    const armScale = Math.max(sd, 0.25 * scale);
    const mean = means[i]!;
    // Balance three positive factors before multiplying. A large bonus times
    // armScale can overflow before uncertainty reduces it; multiplying the
    // two smallest factors first can instead underflow unnecessarily.
    const factors = [settings.bonusMultiplier, armScale / scoreScale,
      Math.sqrt(logMass / Math.max(a.moments.weight, 1))].sort((a, b) => a - b);
    const bonus = (factors[0]! * factors[2]!) * factors[1]!;
    return {
      armId: a.armId, weight: a.moments.weight, meanReward: mean,
      score: mean / scoreScale + bonus,
    };
  });
  return { scored, scoreScale };
}

/** Settings for scoring completed evidence and allocating exploration. */
export type UnreservedPolicySettings = Pick<ExperimentSettings,
  'learningHalfLifeMs' | 'rewardScale' | 'bonusMultiplier' | 'explorationFloor' | 'bootstrapQuota'> & {
    /** Maximum total initial allocation to arms without enough recent completed evidence.
     * The exploration floor still applies. All-cold allocation blends uniform and scored selection. */
    readonly bootstrapShare: number;
  };
export type UnreservedPolicyEvaluation = Omit<PolicyEvaluation, 'arms'> & {
  readonly arms: readonly ArmEvaluation[];
};

/** Evaluate only active arms. Finishing a sample never ends the experiment.
 * Old evidence decays, so an abandoned arm can re-enter bounded initial exploration.
 * This is an optimistic heuristic for unbounded rewards, not an A/B significance test.
 */
export function evaluateUnreservedPolicy(
  arms: readonly PolicyArm[], settings: UnreservedPolicySettings, now: number,
): UnreservedPolicyEvaluation {
  invariant(Number.isFinite(now) && now >= 0, 'invalid_input', 'Invalid policy time');
  invariant(Number.isFinite(settings.bootstrapShare) && settings.bootstrapShare > 0 && settings.bootstrapShare < 1,
    'invalid_input', 'bootstrapShare must be between zero and one');
  invariant(Number.isFinite(settings.explorationFloor) && settings.explorationFloor > 0 && settings.explorationFloor <= 1,
    'invalid_input', 'explorationFloor must be in (0, 1]');
  invariant(Number.isSafeInteger(settings.bootstrapQuota) && settings.bootstrapQuota > 0,
    'invalid_input', 'bootstrapQuota must be a positive integer');
  invariant(Number.isFinite(settings.rewardScale) && settings.rewardScale > 0
    && Number.isFinite(settings.bonusMultiplier) && settings.bonusMultiplier > 0
    && Number.isFinite(settings.learningHalfLifeMs) && settings.learningHalfLifeMs > 0,
  'invalid_input', 'Policy scales and half-life must be positive and finite');
  invariant(new Set(arms.map(a => a.armId)).size === arms.length, 'invalid_input', 'Duplicate policy arm');
  if (arms.length === 0) return { scoreScale: settings.rewardScale, asOf: now, arms: [] };
  // Stable order is part of local deterministic selection, independent of config insertion order.
  const ordered = [...arms].sort((a, b) => compareIdentifiers(a.armId, b.armId));
  const { scored, scoreScale } = scoreArms(ordered, settings, now);
  const cold = scored.filter(a => a.weight < settings.bootstrapQuota);
  const warm = scored.filter(a => a.weight >= settings.bootstrapQuota);
  const floor = settings.explorationFloor / scored.length;
  if (warm.length === 0) {
    // A low-rate stream may never accumulate quota units before decay. Admit
    // relative evidence gradually, while empty initialization remains uniform.
    const alpha = Math.min(1, Math.max(...scored.map(a => a.weight)) / settings.bootstrapQuota);
    const best = Math.max(...scored.map(a => a.score));
    const winners = scored.filter(a => a.score === best);
    return { scoreScale, asOf: now, arms: scored.map(a => ({ ...a,
      probability: (1 - alpha) / scored.length + alpha * (floor
        + (a.score === best ? (1 - settings.explorationFloor) / winners.length : 0)),
    })) };
  }
  // Cold arms share one budget, even if many arms are added at once. The floor is
  // explicit: a configured 100% exploration rate necessarily overrides this cap.
  const coldMass = cold.length === 0 ? 0
    : Math.max(floor * cold.length, Math.min(settings.bootstrapShare, cold.length / scored.length));
  // Protection tapers with completed evidence. It is not a statistical rejection
  // of losing arms: decay restores protection, and every arm retains its floor.
  const protection = (weight: number) => floor + (coldMass / cold.length - floor)
    * (1 - weight / settings.bootstrapQuota);
  const protectedMass = cold.reduce((sum, a) => sum + protection(a.weight), 0);
  const warmBest = Math.max(...warm.map(a => a.score));
  const coldBest = Math.max(...cold.map(a => a.score));
  const warmWinners = warm.filter(a => a.score === warmBest);
  const coldWinners = cold.filter(a => a.score === coldBest);
  const surplus = Math.max(0, 1 - protectedMass - floor * warm.length);
  // Compete for unprotected mass, splitting ties equally until the collective
  // cold cap binds. Warm winners then own the remaining mass.
  const coldExtra = coldBest < warmBest ? 0 : Math.min(Math.max(0, coldMass - protectedMass),
    coldBest === warmBest ? surplus * (coldWinners.length / (coldWinners.length + warmWinners.length)) : surplus);
  return { scoreScale, asOf: now, arms: scored.map((a) => ({ ...a,
    probability: a.weight < settings.bootstrapQuota
      ? protection(a.weight) + (a.score === coldBest ? coldExtra / coldWinners.length : 0)
      : floor + (a.score === warmBest ? (surplus - coldExtra) / warmWinners.length : 0),
  })) };
}

export function chooseArm<T extends { readonly probability: number }>(evaluation: { readonly arms: readonly T[] }, random: number): T | null {
  invariant(Number.isFinite(random) && random >= 0 && random < 1, 'invalid_input', 'Random draw must be in [0, 1)');
  let cumulative = 0;
  for (const arm of evaluation.arms) {
    cumulative += arm.probability;
    if (random < cumulative) return arm;
  }
  // Sum can be one ulp below 1; the last arm owns that rounding remainder.
  return evaluation.arms.at(-1) ?? null;
}

export function randomUnit(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 4_294_967_296;
}
