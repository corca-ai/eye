/** Every timestamp is Unix milliseconds; every duration is milliseconds. */
/** 최상위 키 → 유한한 숫자·문자열·boolean·null. 중첩 객체와 배열은 지원하지 않는다. */
export type Attributes = Readonly<Record<string, string | number | boolean | null>>;
/** 수집·배정에는 cid가 항상 필요하고 uid가 있으면 우선한다. 빈 uid 대신 속성을 생략한다. */
export type Subject = { readonly cid: string; readonly uid?: string };
export type GoalStatus = 'active' | 'paused' | 'deleted';
export type ArmStatus = 'active' | 'paused' | 'deleted';
export type ExperimentStatus = ArmStatus;
export type ObservationStatus = 'pending' | 'complete' | 'interrupted';

export interface ExperimentSettings {
  /** 기본 7일. 마지막 실제 노출의 유한한 귀속 기간(ms). */
  readonly attributionWindowMs?: number;
  /** 기본 0.2. 충분한 최근 표본이 없는 arm들의 초기 탐색 예산. */
  readonly bootstrapShare?: number;
  /** 필수. 배정 시각부터 같은 arm을 유지할 최소 시간(ms), 0 이상. 실제 재배정은 진행 중인 관측 종료도 기다린다. */
  readonly minHoldMs: number;
  /** 기본 7일. 첫 실제 노출부터 한 완료 표본을 평가하는 기간(ms), 양의 정수. */
  readonly observationWindowMs: number;
  /** 기본 1일. 마지막 노출에서 goal까지의 간격에 따른 귀속 보상 반감기(ms), 양의 정수. */
  readonly attributionHalfLifeMs: number;
  /** 기본 14일. 완료 표본의 학습 가중치를 잊는 반감기(ms), 양의 정수. 귀속 반감기와 독립적이다. */
  readonly learningHalfLifeMs: number;
  /** 기본 1시간. 관측 종료 후 최초 완료를 기다리는 시간(ms), 0 이상. 사이트의 과거 최대 관측·유예·귀속 기간 합이 60일에서 1시간을 뺀 값보다 작아야 한다. */
  readonly allowedLatenessMs: number;
  /** 기본 0.02. 신규 배정 전체 중 균등 탐색 비율, 0 초과 1 이하. arm별 하한은 이 값 / 활성 arm 수이다. */
  readonly explorationFloor: number;
  /** 기본 1. 분산이 작거나 자료가 없을 때 탐색 보너스의 최소 가치 척도, 양수. 보상을 자르는 상한이 아니다. */
  readonly rewardScale: number;
  /** 기본 2. 불확실성 보너스 배수, 양수. 높이면 score에서 불확실성의 비중이 커진다. */
  readonly bonusMultiplier: number;
  /** 기본 8. 감쇠 표본 가중치가 이 값보다 작은 arm을 초기 탐색 대상으로 보는 기준, 양의 정수. */
  readonly bootstrapQuota: number;
}
/** 최초 정의. arms는 중복 없는 비어 있지 않은 ID 목록이다. settings에서 minHoldMs만 필수다. */
export interface CreateExperiment {
  readonly experimentId: string;
  readonly arms: readonly string[];
  readonly settings: Pick<ExperimentSettings, 'minHoldMs'> & Partial<Omit<ExperimentSettings, 'minHoldMs'>>;
}
export interface Experiment {
  /** Missing on legacy records means active. */
  readonly status?: ExperimentStatus;
  readonly experimentId: string;
  readonly generation: number;
  readonly revision: number;
  readonly createdAt: number;
  readonly settings: ExperimentSettings;
  readonly arms: readonly { readonly armId: string; readonly status: ArmStatus }[];
}
/** 서버가 발급한 배정. settings는 배정 당시 고정되며 probability는 신규 선택 당시 확률이다. 직접 만들거나 수정하지 않는다. */
export interface Assignment {
  readonly assignmentId: string;
  readonly experimentId: string;
  readonly armId: string;
  readonly generation: number;
  readonly assignedAt: number;
  readonly policyRevision: number;
  readonly probability: number;
  readonly settings: ExperimentSettings;
}
export type Decision =
  | { readonly status: 'assigned'; readonly assignment: Assignment; readonly reason: 'selected' | 'held' | 'adopted'; readonly routingKey?: string; readonly localContext?: import('./local-assignment.js').LocalAssignmentContext; readonly applyUntil?: number }
  | { readonly status: 'no_active_arm' | 'unavailable'; readonly experimentId: string };

interface EventBase {
  /** 재시도할 때 동일한 subject·payload와 함께 재사용하는 이벤트 ID. */
  readonly eventId: string;
  /** 사건이 실제 발생한 Unix 밀리초. SDK 입력에서 생략하면 Date.now(). 미래 또는 60일 초과 과거는 거절한다. */
  readonly occurredAt: number;
  readonly subject: Subject;
  readonly attributes?: Attributes;
}
export type TrackEvent = EventBase & { readonly kind: 'track'; readonly name: string };
export type GoalEvent = EventBase & { readonly kind: 'goal'; readonly goalId: string; readonly value: number };
export type ExposureEvent = EventBase & {
  readonly kind: 'exposure'; readonly assignment: Assignment; readonly userAttributes?: Attributes; readonly routingKey?: string;
  readonly sample?: { readonly sampleId: string; readonly startAt: number }; readonly attributionWindowMs?: number;
};
export type IdentityEvent = EventBase & { readonly kind: 'identify' | 'logout' };
export type EyeEvent = TrackEvent | GoalEvent | ExposureEvent | IdentityEvent;
export interface EventEnvelope {
  readonly siteId: string;
  readonly receivedAt: number;
  readonly event: EyeEvent;
}
export interface Observation {
  readonly observationId: string;
  readonly assignmentId: string;
  readonly subjectKey: string;
  readonly experimentId: string;
  readonly armId: string;
  readonly generation: number;
  readonly revision: number;
  readonly startAt: number;
  readonly endAt: number;
  readonly status: ObservationStatus;
  readonly reward: number;
  readonly attributes: Attributes;
  readonly subject?: Subject;
  readonly interruptReason?: 'identity' | 'arm_stopped' | 'configuration' | 'correction_expired';
}
export interface Exposure {
  readonly eventId: string;
  readonly occurredAt: number;
  readonly assignment: Assignment;
  readonly observationId: string | null;
}
export interface Credit {
  readonly goalEventId: string;
  readonly experimentId: string;
  readonly armId: string;
  readonly exposureId: string;
  readonly assignmentId: string;
  readonly observationId: string | null;
  readonly experimentCount: number;
  readonly baseValue: number;
  readonly decayFactor: number;
  readonly value: number;
  readonly learningEligible: boolean;
  /** Analytic attribution may change after the corresponding learning window is frozen. */
  readonly learningClosed?: boolean;
}
