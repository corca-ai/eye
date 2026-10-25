import type { AnalyticsAPI } from './types.js';
import type { SummaryQuery, SummaryReport, SummaryTarget } from './summaries.js';

export type AnalyticsKind = keyof AnalyticsAPI | 'summary';
/** 기존 분석과 같은 조회 조건. summary는 명시적으로 선택한 로컬 시간별 요약이며 원본 SQL로 대체하지 않는다. */
export type AnalyticsRequest = { [K in keyof AnalyticsAPI]: { kind: K; query: Parameters<AnalyticsAPI[K]>[0] } }[keyof AnalyticsAPI]
  | { kind: 'summary'; query: SummaryQuery };
export type AnalyticsResult = { [K in keyof AnalyticsAPI]: { kind: K; data: Awaited<ReturnType<AnalyticsAPI[K]>> } }[keyof AnalyticsAPI]
  | { kind: 'summary'; data: SummaryReport };
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
  job: AnalyticsJob; request: AnalyticsRequest; result: AnalyticsResult; offset: number; nextOffset: number | null;
}
export interface AnalyticsJobsAPI {
  /** site당 최대 32개. 같은 scope/ID/설정은 재등록해도 재실행하지 않는다. 설정 변경은 새 결과를 생성한다. */
  schedule(input: ReportScheduleInput): Promise<ReportSchedule>;
  /** 조회는 새 작업을 시작하지 않는다. latestJob의 저장 결과는 page로 읽는다. */
  scheduled(input: ReportScheduleRef): Promise<ReportSchedule>;
  /** 향후 실행을 중단한다. 이미 만들어진 공유 job과 저장 결과는 자체 만료까지 유지한다. */
  unschedule(input: ReportScheduleRef): Promise<void>;

  /** 같은 site/scope/정규화 조건의 실행 중 작업을 공유하고 완료 결과는 15분 재사용한다. 등록은 SQL 완료를 기다리지 않는다. */
  create(input: AnalyticsJobInput): Promise<AnalyticsJob>;
  /** 일반 작업/결과는 등록 후 1시간 보관한다. 자동 보고서는 생성 당시 intervalMs × 2 + 1시간 보관한다. 다른 scope 또는 만료된 ID는 not_found. */
  status(input: AnalyticsJobRef): Promise<AnalyticsJob>;
  /** 저장된 결과를 읽는다. 기본 100행, 최대 1000행. offset은 결과 내 위치이며 조회를 재실행하지 않는다.
   * 원본 조회는 meta.truncated, summary는 meta.basis/coverageFrom/queriedAt을 확인한다. */
  page(input: AnalyticsJobRef & { offset?: number; limit?: number }): Promise<AnalyticsJobPage>;
  /** queued/running 작업을 취소한다. 이미 실행한 원격 SQL의 과금까지 취소하지는 못한다. 동일 scope의 공유 작업에 적용된다. */
  cancel(input: AnalyticsJobRef): Promise<AnalyticsJob>;
}

/** 자주 사용하는 기본 보고서만 자동 생성한다. 임의 필터 조합은 jobs.create를 사용한다. */
export type BasicReport = { kind: 'learning'; experimentId?: string } | { kind: 'goals' }
  | { kind: 'summary'; target: SummaryTarget };
export interface ReportScheduleRef { scope: string; scheduleId: string }
export interface ReportScheduleInput extends ReportScheduleRef {
  report: BasicReport;
  /** 최근 windowMs 구간. 1시간~59일. summary는 정수 시간이며 마지막 완료 UTC 시각까지 조회한다.
   * 원시 보고서는 실행 시각을 끝으로 한다. 누락된 실행을 소급 반복하지 않는다. */
  windowMs: number;
  /** 기본 1시간, 1~24시간. 실제 완료는 저장소 지연·대기열·재시도만큼 늦을 수 있다. */
  intervalMs?: number;
}
export interface ReportSchedule extends ReportScheduleInput {
  intervalMs: number; nextAt: number; currentJob: AnalyticsJob | null; latestJob: AnalyticsJob | null;
  error: string | null;
}
