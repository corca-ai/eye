/** 명시적으로 활성화할 로컬 요약 대상. 원본 저장소를 조회하거나 과거 데이터를 소급 집계하지 않는다. */
export interface SummaryConfig {
  /** goalIds와 experimentIds 합계 최대 32개. 두 목록이 모두 비면 수집을 중단한다. */
  goalIds: string[];
  experimentIds: string[];
}
/** 로컬 요약의 설정·수집 상태. capacity_exceeded이면 조회도 중단하며 원본 수집·학습은 계속한다. */
export interface SummaryStatus {
  config: SummaryConfig;
  state: 'disabled' | 'collecting' | 'capacity_exceeded';
  /** 골 발생/관측 시작 기준으로 수집 범위에 들어오는 첫 UTC 시간 경계(Unix ms). 과거 backfill은 없다. */
  coverageFrom: number | null;
  bucketMs: number;
}
/** 사전에 활성화한 골 하나 또는 실험 하나. 속성 필터·사용자군별 분리는 지원하지 않는다. */
export type SummaryTarget = { kind: 'goals'; goalId: string } | { kind: 'learning'; experimentId: string };
/** [from, to)의 완료 UTC 시간 구간(Unix ms). coverage 안에서 최대 59일이며 현재 진행 중인 시간은 제외한다. */
export type SummaryQuery = { from: number; to: number } & SummaryTarget;
/** count는 accepted 골 또는 완료 표본 수, total은 비감쇠 합계, mean은 total/count. 사건 없는 그룹은 생략한다. */
export type SummaryRow = { count: number; total: number; mean: number } & (
  { kind: 'goals'; goalId: string } |
  { kind: 'learning'; experimentId: string; armId: string; generation: number; observationWindowMs: number }
);
/** 조회 시점의 로컬 집계. 늦은 골·후속 관측 마감으로 과거 구간의 값도 바뀔 수 있다. */
export interface SummaryReport {
  rows: SummaryRow[];
  meta: {
    basis: 'durable_local'; from: number; to: number; coverageFrom: number; bucketMs: number;
    /** 집계를 읽은 Unix ms. 데이터 수신 완료나 원본 사건의 수신 시각을 뜻하지 않는다. */
    queriedAt: number;
  };
}
/** 원본 SQL 없이 기본 합계를 읽는다. 범위 부족을 빈 성공 결과나 원본 조회로 자동 대체하지 않는다. */
export interface SummariesAPI {
  /** 관리 경로에서 호출한다. 목록 변경은 전체 요약을 초기화하며 동일 설정 재시도는 보존한다.
   * capacity_exceeded 이후에는 빈 목록으로 비활성화한 뒤 다시 설정한다. */
  configure(config: SummaryConfig): Promise<SummaryStatus>;
  /** 활성 대상과 수집 범위를 읽는다. 새 수집·원본 조회를 시작하지 않는다. */
  status(): Promise<SummaryStatus>;
  /** 완료 UTC 시간 구간을 조회한다. 잘못된 구간은 invalid_input, coverage 부족은 unavailable로 실패한다. */
  query(query: SummaryQuery): Promise<SummaryReport>;
}
