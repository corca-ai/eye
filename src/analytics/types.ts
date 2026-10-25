/** 속성·필터·그룹 값. 숫자는 유한해야 하며 중첩 구조는 지원하지 않는다. */
export type Scalar = string | number | boolean | null;
/** 속성 키와 조회할 값의 타입. 문자열 "1"과 숫자 1은 별개다. */
export interface AttributeField { key: string; type: 'string' | 'number' | 'boolean' }
/** 타입을 자동 변환하지 않는다. 최대 64노드·깊이 8, in 최대 100값. eq:null과 missing은 다르다. */
export type Filter =
  | { and: readonly Filter[] } | { or: readonly Filter[] } | { not: Filter }
  | { field: AttributeField; op: 'eq' | 'ne'; value: Scalar }
  | { field: AttributeField; op: 'lt' | 'lte' | 'gt' | 'gte'; value: number }
  | { field: AttributeField; op: 'in'; value: readonly Scalar[] }
  | { field: AttributeField; op: 'exists' | 'missing' };
/** from/to는 최근 60일 안의 Unix 밀리초, [from, to). limit은 기본 100, 1~1000. */
export interface QueryRange { from: number; to: number; limit?: number }
/** filter/groupBy는 최초 노출 userAttributes, 기간은 관측 시작 시각 기준. groupBy 최대 3개. goalId는 분자만 제한한다. */
export interface ArmQuery extends QueryRange {
  experimentId: string; armId?: string; generation?: number; goalId?: string; groupBy?: readonly AttributeField[]; filter?: Filter;
  /** Restrict to observations containing a matching track event, without duplicating the denominator. */
  hasEvent?: { name: string; filter?: Filter };
}
/** cid 또는 uid 하나의 이력. 다음 페이지는 같은 조회 조건과 응답의 nextCursor를 사용한다. */
export interface TimelineQuery extends QueryRange {
  subject: { cid: string; uid?: never } | { uid: string; cid?: never };
  /** Include anonymous events in the interval claimed by the first subsequent login. Defaults to true. */
  includeLinked?: boolean; cursor?: string;
}
/** 발생 시각 기준 accepted 원본 골 합계. filter는 사건 attributes에 적용한다. */
export interface GoalQuery extends QueryRange { goalId?: string; filter?: Filter }
/** bucketMs는 양의 정수 밀리초이며 Unix epoch 기준 UTC 경계로 묶는다. */
export interface SeriesQuery extends GoalQuery { bucketMs: number }
/** 원본 사건 attributes의 값별 빈도. 관측 userAttributes의 분포와 별개다. */
export interface AttributeValuesQuery extends QueryRange { field: AttributeField; filter?: Filter }
/** 원본 조회의 실행 정보. 시각은 Unix ms이며 최신 데이터가 모두 도착했다는 보장은 없다. */
export interface AnalyticsMeta {
  queriedAt: number;
  /** Upper bound on received_at, not an ingestion watermark or an Iceberg snapshot. */
  receivedBefore: number;
  consistency: 'eventual';
  /** limit으로 일부 행이 생략됨. 집계 조회는 조건을 좁혀 다시 조회한다. */
  truncated: boolean;
  /** 조회 서비스가 보고한 스캔 바이트. 제공하지 않으면 null이며 0으로 해석하지 않는다. */
  bytesScanned: number | null;
}
/** arm·세대·관측 기간·사용자군별 성과. 평균 차이가 인과적 uplift를 뜻하지는 않는다. */
export interface ArmRow {
  armId: string; generation: number; observationWindowMs: number;
  /** 요청 groupBy와 같은 순서의 값. */
  groups: Scalar[];
  completed: number; pending: number; interrupted: number;
  /** 관측에 기록된 고유 신원 키 수. cid/uid 전환을 합친 실제 사람 수가 아니다. */
  subjects: number;
  /** 현재 조회 가능한 원본으로 재계산한 귀속 보상. */
  totalValue: number;
  /** 확정 당시 학습에 반영한 전체 goal 보상. goalId 필터와 무관하다. */
  learningValue: number;
  /** totalValue / completed. 완료 표본이 없으면 null; 미달성 완료 표본도 분모에 포함한다. */
  meanValue: number | null; latestReceivedAt: number;
}
/** 조회 가능한 사건·관측·귀속·배정·신원 이력 한 행. 해당 종류에 없는 필드는 null이다. */
export interface TimelineRow {
  table: 'events' | 'observations' | 'credits' | 'decisions' | 'identity_links';
  recordId: string; revision: number; occurredAt: number; receivedAt: number;
  cid: string | null; uid: string | null; subjectKey: string;
  experimentId: string | null; armId: string | null; goalId: string | null;
  status: string | null; value: number | null;
  attributes: Record<string, Scalar>; payload: Record<string, unknown>;
}
/** 중복 제거된 accepted 원본 골 수·가치 합. 여러 실험의 credit을 다시 합산하지 않는다. */
export interface GoalRow { goalId: string; events: number; totalValue: number; latestReceivedAt: number }
/** 골 발생 시각을 묶은 UTC bucket. bucketStart는 Unix ms이며 사건 없는 bucket은 생략한다. */
export interface SeriesRow extends GoalRow { bucketStart: number }
/** 지정 속성 값의 원본 사건 빈도. latestReceivedAt은 관측한 수신 시각의 최댓값이다. */
export interface AttributeValueRow { value: Scalar; events: number; latestReceivedAt: number }
/** rows는 집계 결과. meta.truncated이면 범위·조건을 좁힌다. 일반 집계에는 다음 페이지 cursor가 없다. */
export interface AnalyticsPage<T> { rows: T[]; meta: AnalyticsMeta }
/** 관측 시작 기간의 원본 재귀속 성과. 확정 학습 보상과 차이가 날 수 있다. */
export interface ArmReport extends AnalyticsPage<ArmRow> { rewardBasis: 'raw_attribution'; cohortBasis: 'observation_start' }
/** 원본 타임라인 페이지. nextCursor=null이면 다음 페이지가 없다. */
export interface TimelinePage extends AnalyticsPage<TimelineRow> { nextCursor: string | null }
/** ArmQuery를 관측 시작 시각의 UTC bucket으로 나눈다. bucketMs는 양의 정수 ms다. */
export interface ArmSeriesQuery extends ArmQuery { bucketMs: number }
/** 관측 시작 bucket별 arm 성과. 분모·필터 의미는 ArmRow와 같다. */
export interface ArmSeriesRow extends ArmRow { bucketStart: number }
/** 실제 노출된 배정·노출의 시계열. bucketMs는 양의 정수 ms다. */
export interface TrafficQuery extends QueryRange { experimentId: string; bucketMs: number }
/** bucket·arm·세대별 배정/노출 수와 비율. 미노출 선택·fallback은 포함하지 않는다. */
export interface TrafficRow { bucketStart: number; armId: string; generation: number; assignments: number; exposures: number; assignmentShare: number | null; exposureShare: number | null }
/** 기간 내 발행 정책 이력. 현재 정책은 experiments.policy로 조회한다. */
export interface PolicyQuery extends QueryRange { experimentId: string; armId?: string }
/** 발행 당시 신규 선택 확률·원래 단위의 평균·scoreScale 단위의 점수. 실제 노출 비율과 다르다. */
export interface PolicyHistoryRow { occurredAt: number; recordId: string; generation: number; armId: string; probability: number; meanReward: number | null; score: number | null; scoreScale: number; reason: string; status: string }
/** 발견한 속성 키·타입·출처. event는 사건 속성, user는 노출의 사용자군 속성이다. */
export interface AttributeKeyRow { key: string; type: 'string' | 'number' | 'boolean' | 'null'; source: 'event' | 'user'; latestReceivedAt: number }
/** 요청이 걸친 UTC 날짜 전체의 속성 목록. coverage가 실제 조회 범위다. */
export interface AttributeKeyReport extends AnalyticsPage<AttributeKeyRow> { coverage: { basis: 'utc_day'; from: number; to: number } }
/** 원본 저장소 조회 API. 집계 결과는 최종 일관성이며 실패는 Promise reject로 전달한다. */
export interface AnalyticsAPI {
  /** 마감 때 확정한 표본 보상 합계·평균. 원본 귀속을 재계산하지 않는다. */
  learning(query: LearningQuery): Promise<LearningReport>;
  /** 관측 시작 bucket별 arm 비교. */
  armSeries(query: ArmSeriesQuery): Promise<AnalyticsPage<ArmSeriesRow>>;
  /** 실제 노출된 배정·노출의 수와 비율. */
  traffic(query: TrafficQuery): Promise<AnalyticsPage<TrafficRow>>;
  /** 발행 정책 이력. 매 로컬 선택의 기록은 아니다. */
  policies(query: PolicyQuery): Promise<AnalyticsPage<PolicyHistoryRow>>;
  /** 요청에 걸친 UTC 날짜 전체의 속성 키·타입·출처. */
  attributeKeys(query: QueryRange): Promise<AttributeKeyReport>;
  /** 관측 시작 기간의 원본 귀속 보상 비교. 사용자군 필터는 최초 노출 기준이다. */
  arms(query: ArmQuery): Promise<ArmReport>;
  /** 한 cid 또는 uid의 이력을 cursor로 이어 읽는다. */
  timeline(query: TimelineQuery): Promise<TimelinePage>;
  /** accepted 원본 골 수·가치 합. */
  goals(query: GoalQuery): Promise<AnalyticsPage<GoalRow>>;
  /** 발생 시각 bucket별 골 합계. 빈 bucket은 생략한다. */
  series(query: SeriesQuery): Promise<AnalyticsPage<SeriesRow>>;
  /** 사건 속성의 값별 빈도. */
  attributeValues(query: AttributeValuesQuery): Promise<AnalyticsPage<AttributeValueRow>>;
}

/** 확정된 관측 결과만 집계한다. 기간은 관측 시작 시각이며 실험을 생략하면 사이트 전체를 조회한다. */
export interface LearningQuery extends QueryRange { experimentId?: string }
/** 완료 표본만의 비감쇠 합계·평균. meanValue는 learningValue/completed이며 0 보상도 분모에 포함한다. */
export interface LearningRow {
  experimentId: string; armId: string; generation: number; observationWindowMs: number;
  completed: number; learningValue: number; meanValue: number; latestReceivedAt: number;
}
/** 감쇠된 정책 점수와 다르다. 확정된 표본 보상의 합계·평균이며 늦은 골로 재계산하지 않는다. */
export interface LearningReport extends AnalyticsPage<LearningRow> { rewardBasis: 'closed_learning'; cohortBasis: 'observation_start' }
