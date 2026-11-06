/** Immutable JSON content; rendering and validation of application fields belong to the host. */
export interface JsonArray extends ReadonlyArray<JsonValue> {}
/** Plain JSON object; field meaning is validated by the service. */
export interface JsonObject { readonly [key: string]: JsonValue }
/** Immutable JSON content bounded at management and selection boundaries. */
export type JsonValue = null | boolean | number | string | JsonArray | JsonObject;
/** Arm identity and optional immutable remote content; host defaults need only an ID. */
export interface ArmDefinition { readonly armId: string; readonly data?: JsonValue }
/** Existing ID-only arms remain supported. Data is immutable for an arm ID. */
export type ArmInput = string | (ArmDefinition & { readonly initialStatus?: 'active' | 'paused' });
/** 최상위 키 → 유한한 숫자·문자열·boolean·null. 중첩 객체와 배열은 지원하지 않는다. */
export type Attributes = Readonly<Record<string, string | number | boolean | null>>;
/** 수집·배정에는 cid가 항상 필요하고 uid가 있으면 우선한다. 빈 uid 대신 속성을 생략한다. */
export type Subject = { readonly cid: string; readonly uid?: string };
/** 골의 발생 시각 기준 수집 상태. deleted는 영구 비활성화이며 ID를 재사용할 수 없다. */
export type GoalStatus = 'active' | 'paused' | 'deleted';
/** 신규 선택 허용 상태. paused는 재개 가능하고 deleted는 영구 비활성화다. */
export type ArmStatus = 'active' | 'paused' | 'deleted';
/** 실험 전체의 선택 허용 상태. 개별 arm 상태와 함께 적용한다. */
export type ExperimentStatus = ArmStatus;
/** 관측의 완료 여부. 평균 분모에는 complete만 포함한다. */
export type ObservationStatus = 'pending' | 'complete';

/** 배정 당시 고정되는 학습 설정. 기간은 ms이며 기본값은 CreateExperiment의 settings 생략 필드에 적용한다.
 * 설치 전체의 과거 최대 관측·귀속 기간과 고정 1분 유예(이전 저장 상한이 더 크면 그 값)의 합은 60일에서 1시간을 뺀 값보다 작아야 한다. */
export interface ExperimentSettings {
  /** 기본 7일. 마지막 실제 노출의 유한한 귀속 기간(ms). */
  readonly attributionWindowMs?: number;
  /** 기본 0.2, 0 초과 1 미만. warm arm이 있을 때 cold arm 전체의 신규 선택 확률 상한(탐색 하한이 우선). 증거에 따라 보호 배정은 줄어든다. */
  readonly bootstrapShare?: number;
  /** 필수. 배정 시각부터 같은 arm을 유지할 최소 시간(ms), 0 이상. 실제 재배정은 진행 중인 관측 종료도 기다린다. */
  readonly minHoldMs: number;
  /** 기본 7일. 첫 실제 노출부터 한 완료 표본을 평가하는 기간(ms), 양의 정수. */
  readonly observationWindowMs: number;
  /** 기본 1일. 마지막 노출에서 goal까지의 간격에 따른 귀속 보상 반감기(ms), 양의 정수. */
  readonly attributionHalfLifeMs: number;
  /** 기본 14일. 완료 표본의 학습 가중치를 잊는 반감기(ms), 양의 정수. 귀속 반감기와 독립적이다. */
  readonly learningHalfLifeMs: number;
  /** 기본 0.02. 신규 배정 전체 중 균등 탐색 비율, 0 초과 1 이하. arm별 하한은 이 값 / 활성 arm 수이다. */
  readonly explorationFloor: number;
  /** 기본 1. 분산이 작거나 자료가 없을 때 탐색 보너스의 최소 가치 척도, 양수. 보상을 자르는 상한이 아니다. */
  readonly rewardScale: number;
  /** 기본 2. 불확실성 보너스 배수, 양수. 높이면 score에서 불확실성의 비중이 커진다. */
  readonly bonusMultiplier: number;
  /** 기본 8. 감쇠 표본 가중치가 이 값보다 작은 arm을 초기 탐색 대상으로 보는 기준, 양의 정수. */
  readonly bootstrapQuota: number;
}
/** 최초 정의. arms는 중복 없는 비어 있지 않은 ID 또는 불변 JSON 데이터 정의 목록이다. settings에서 minHoldMs만 필수다. */
export interface CreateExperiment {
  /** Initial selection state; defaults to active. Applied atomically with creation. */
  readonly initialStatus?: 'active' | 'paused';
  readonly experimentId: string;
  readonly arms: readonly ArmInput[];
  readonly settings: Pick<ExperimentSettings, 'minHoldMs'> & Partial<Omit<ExperimentSettings, 'minHoldMs'>>;
}
/** 현재 실험 정의. 배정 전략 변경은 학습을 유지하며 관측·귀속·학습 반감기·유지 기간 변경은 새 generation으로 학습한다. */
export interface Experiment {
  /** 실험 전체의 선택 허용 상태. */
  readonly status: ExperimentStatus;
  readonly experimentId: string;
  /** 보상·학습 의미가 호환되는 설정끼리 공유하는 학습 세대. */
  readonly generation: number;
  /** 정의 변경 버전. 정책 발행 sequence와 별개다. */
  readonly revision: number;
  readonly createdAt: number;
  readonly settings: ExperimentSettings;
  readonly arms: readonly (ArmDefinition & { readonly status: ArmStatus })[];
}
/** 서버가 발급한 배정. settings는 배정 당시 고정되며 probability는 신규 선택 당시 확률이다. 직접 만들거나 수정하지 않는다. */
export interface AssignmentBase {
  readonly assignmentId: string;
  readonly experimentId: string;
  readonly armId: string;
  readonly generation: number;
  readonly assignedAt: number;
  readonly settings: ExperimentSettings;
}
/** 정책 선택과 성능상 기본 arm 적용을 구분한다. 과거 allocation 생략은 policy다. */
export type Assignment = AssignmentBase & (
  | { readonly allocation?: 'policy'; readonly policyRevision: number; readonly probability: number }
  | { readonly allocation: 'default'; readonly policyRevision: null; readonly probability: null; readonly authorityRevision: number }
);
/** 성능상 기본 arm을 적용한 이유. 노출별로 기록하며 관측의 정의를 바꾸지 않는다. */
export type DefaultReason = 'unprepared' | 'deadline' | 'resource_unready' | 'invalid_data';

/** assigned만 실제 적용 후 expose한다. unavailable은 정책 미준비/만료 등, no_active_arm은 비활성 상태다.
 * localContext·applyUntil은 SDK 노출 검증용이므로 결정 객체를 직접 만들거나 변경하지 않는다. */
export type Decision =
  | { readonly status: 'assigned'; readonly data?: JsonValue; readonly assignment: Assignment; readonly reason: 'selected' | 'held'; readonly localContext?: import('./local-assignment.js').LocalAssignmentContext; readonly applyUntil?: number }
  | { readonly status: 'no_active_arm' | 'unavailable'; readonly experimentId: string };

interface EventBase {
  /** 재시도할 때 동일한 subject·payload와 함께 재사용하는 이벤트 ID. */
  readonly eventId: string;
  /** 사건이 실제 발생한 Unix 밀리초. SDK 입력에서 생략하면 Date.now(). SDK와 수집 서버는 미래 또는 발생 후 15초 초과 외부 제출을 거절한다. Queue 재시도는 최초 서버 수신 시각과 60일 보존 경계를 따른다. */
  readonly occurredAt: number;
  readonly subject: Subject;
  readonly attributes?: Attributes;
}
/** 서비스 정의 행동 로그. 분석에 사용하며 직접 학습 보상을 만들지는 않는다. */
export type TrackEvent = EventBase & { readonly kind: 'track'; readonly name: string };
/** 등록된 goal의 실제 발생과 가치. 사이트 내 모든 goal의 단위를 통일하며 유한한 음수·0도 허용한다. */
export type GoalEvent = EventBase & { readonly kind: 'goal'; readonly goalId: string; readonly value: number };
/** 실제 적용한 배정의 노출 원본. SDK expose가 표본 문맥을 구성하므로 직접 생성하지 않는다. */
export type ExposureEvent = EventBase & {
  readonly kind: 'exposure'; readonly assignment: Assignment; readonly userAttributes?: Attributes; readonly defaultReason?: DefaultReason;
  readonly sample?: { readonly sampleId: string; readonly startAt: number }; readonly attributionWindowMs?: number;
};
/** identify는 인증된 cid+uid, logout은 cid만 전달한다. 호스트의 로그인·세션 상태를 변경하지 않는다. */
export type IdentityEvent = EventBase & { readonly kind: 'identify' | 'logout' };
/** 수집 가능한 사건 원본의 구분 유니온. 일반 호출에는 EventInput을 사용하는 SDK 메서드를 쓴다. */
export type EyeEvent = TrackEvent | GoalEvent | ExposureEvent | IdentityEvent;
export interface EventEnvelope {
  readonly siteId: string;
  readonly receivedAt: number;
  readonly event: EyeEvent;
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
