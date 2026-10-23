import { invariant } from './errors.js';
import { ageMoments, emptyMoments, meanOf, mergeMoments, stddevOf } from './moments.js';
import type { Moments } from './moments.js';
import type { ExperimentSettings } from './types.js';

export interface PolicyArm {
  readonly armId: string;
  readonly moments: Readonly<Moments>;
  readonly pending: number;
}
export interface ArmEvaluation {
  readonly armId: string;
  /** 시간 감쇠된 완료 표본 가중치 합. 정수 사용자 수가 아니다. */
  readonly weight: number;
  /** 원래 가치 단위의 감쇠 평균. 해당 arm 자료가 없으면 전체 arm의 평균(전체도 없으면 0). */
  readonly meanReward: number;
  /** 결과를 기다리는 유효 예약·관측 수. 완료 표본에 포함하지 않는다. */
  readonly pending: number;
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

/** Pure evaluation: no randomness, I/O, mutations, or hidden wall clock. */
export function evaluatePolicy(arms: readonly PolicyArm[], settings: ExperimentSettings, now: number): PolicyEvaluation {
  if (arms.length === 0) return { scoreScale: settings.rewardScale, asOf: now, arms: [] };
  invariant(new Set(arms.map(a => a.armId)).size === arms.length, 'invalid_input', 'Duplicate policy arm');
  const aged = arms.map(a => {
    invariant(Number.isSafeInteger(a.pending) && a.pending >= 0, 'invalid_input', 'Pending count must be a nonnegative integer');
    return { ...a, moments: ageMoments(a.moments, now, settings.learningHalfLifeMs) };
  });
  let pooled = emptyMoments(now);
  for (const arm of aged) pooled = mergeMoments(pooled, arm.moments);
  const scale = Math.max(settings.rewardScale, stddevOf(pooled));
  const pooledMean = meanOf(pooled);
  const means = aged.map(a => a.moments.weight > 1e-12 ? meanOf(a.moments) : pooledMean);
  // Include means so even rewards near Number.MAX_VALUE can be ranked safely.
  const scoreScale = Math.max(scale, ...means.map(Math.abs));
  const logMass = Math.log(2 + pooled.weight + aged.reduce((s, a) => s + a.pending, 0));
  const scored = aged.map((a, i) => {
    const sd = a.moments.weight > 1e-12 ? stddevOf(a.moments) : scale;
    const armScale = Math.max(sd, 0.25 * scale);
    const mean = means[i]!;
    return {
      armId: a.armId, weight: a.moments.weight, meanReward: mean, pending: a.pending,
      score: mean / scoreScale + settings.bonusMultiplier * (armScale / scoreScale)
        * Math.sqrt(logMass / (Math.max(a.moments.weight, 1) + settings.pendingPenalty * a.pending)),
    };
  });
  const cold = scored.filter(a => a.weight < settings.bootstrapQuota && a.pending < settings.bootstrapQuota);
  let preferred: Set<string>;
  if (cold.length > 0) {
    const pressure = Math.min(...cold.map(a => a.weight + a.pending));
    preferred = new Set(cold.filter(a => a.weight + a.pending === pressure).map(a => a.armId));
  } else {
    const best = Math.max(...scored.map(a => a.score));
    preferred = new Set(scored.filter(a => a.score === best).map(a => a.armId));
  }
  const floor = settings.explorationFloor / scored.length;
  return {
    scoreScale, asOf: now,
    arms: scored.map(a => ({ ...a, probability: floor + (preferred.has(a.armId) ? (1 - settings.explorationFloor) / preferred.size : 0) })),
  };
}

export function chooseArm(evaluation: PolicyEvaluation, random: number): ArmEvaluation | null {
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
