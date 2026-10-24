import type { AnalyticsAPI } from './types.js';

export type AnalyticsKind = keyof AnalyticsAPI;
/** 기존 분석과 같은 조회 조건. SQL이나 임의 코드는 받지 않는다. */
export type AnalyticsRequest = { [K in AnalyticsKind]: { kind: K; query: Parameters<AnalyticsAPI[K]>[0] } }[AnalyticsKind];
export type AnalyticsResult = { [K in AnalyticsKind]: { kind: K; data: Awaited<ReturnType<AnalyticsAPI[K]>> } }[AnalyticsKind];
/** scope는 호스트가 인증·권한·필터를 확인한 뒤 공급하는 캐시 격리 키다. 브라우저 입력을 그대로 쓰지 않는다. */
export interface AnalyticsJobInput { scope: string; request: AnalyticsRequest }
export interface AnalyticsJobRef { scope: string; jobId: string }
export interface AnalyticsJob {
  jobId: string; kind: AnalyticsKind; status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  createdAt: number; completedAt: number | null; expiresAt: number; attempts: number;
  /** 결과를 재사용할 수 있는 시각. 이후 같은 조건을 등록하면 새 작업을 만든다. */
  freshUntil: number | null;
  error: string | null;
}
export interface AnalyticsJobPage {
  job: AnalyticsJob; result: AnalyticsResult; offset: number; nextOffset: number | null;
}
export interface AnalyticsJobsAPI {
  /** 같은 site/scope/정규화 조건의 실행 중 작업을 공유하고 완료 결과는 15분 재사용한다. 등록은 SQL 완료를 기다리지 않는다. */
  create(input: AnalyticsJobInput): Promise<AnalyticsJob>;
  /** 작업/결과는 등록 후 1시간 보관한다. 다른 scope 또는 만료된 ID는 not_found. */
  status(input: AnalyticsJobRef): Promise<AnalyticsJob>;
  /** 저장된 결과를 읽는다. 기본 100행, 최대 1000행. offset은 결과 내 위치이며 SQL을 재실행하지 않는다. 원래 조회의 meta.truncated도 확인한다. */
  page(input: AnalyticsJobRef & { offset?: number; limit?: number }): Promise<AnalyticsJobPage>;
  /** queued/running 작업을 취소한다. 이미 실행한 원격 SQL의 과금까지 취소하지는 못한다. 동일 scope의 공유 작업에 적용된다. */
  cancel(input: AnalyticsJobRef): Promise<AnalyticsJob>;
}
