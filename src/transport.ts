import type { SummariesAPI } from './analytics/summaries.js';
import type { AnalyticsJobsAPI } from './analytics/jobs.js';
import type { ArmStatus, Assignment, CreateExperiment, Decision, EventEnvelope, Experiment, ExperimentSettings, GoalStatus, Subject } from './core/types.js';
import type { GoalDefinition } from './runtime/site.js';
import type { UnreservedPolicyEvaluation } from './core/policy.js';
import type { AnalyticsAPI } from './analytics/types.js';

/** statsAsOf는 마지막 적용한 마감 구간의 기준 시각이며 null은 적용 이력 없음. 전체 데이터 수신 완료 watermark가 아니다. */
export interface PolicySnapshot extends UnreservedPolicyEvaluation {
  experimentId: string; generation: number; revision: number; statsAsOf: number | null;
}
/** 로컬 선택에 사용하는 발행 정책. sequence는 발행 순서, publishedAt은 발행 Unix ms이며 조회로 연장되지 않는다. */
export interface PublishedPolicy extends PolicySnapshot {
  settings: ExperimentSettings;
  publishedAt: number; sequence: number;
  /** 실험 전체의 상태와 신규 선택 가능한 arm ID 목록. */
  status: ArmStatus; activeArms: string[];
}
/** reuseUntil은 이번 결정의 적용 기한(Unix 밀리초)이다. 정책 유효기간과 유지·관측 조건으로 결정하며 저장 문맥의 삭제 시각은 아니다. */
export interface PreparedDecision { decision: Decision; reuseUntil: number; policy: PublishedPolicy }
/** 호스트 Worker의 Service Binding 타입. 바인딩 이름은 자유이며 일반 연동은 createEye로 호출한다.
 * 저수준 RPC 계약이며 호스트의 사용자 인증이나 HTTP 라우팅을 대신하지 않는다. */
export interface EyeService {
  configureSummaries(siteId: string, input: Parameters<SummariesAPI['configure']>[0]): ReturnType<SummariesAPI['configure']>;
  summaryStatus(siteId: string): ReturnType<SummariesAPI['status']>;
  querySummary(siteId: string, input: Parameters<SummariesAPI['query']>[0]): ReturnType<SummariesAPI['query']>;
  analyticsJobSchedule(siteId: string, input: Parameters<AnalyticsJobsAPI['schedule']>[0]): ReturnType<AnalyticsJobsAPI['schedule']>;
  analyticsJobScheduled(siteId: string, input: Parameters<AnalyticsJobsAPI['scheduled']>[0]): ReturnType<AnalyticsJobsAPI['scheduled']>;
  analyticsJobUnschedule(siteId: string, input: Parameters<AnalyticsJobsAPI['unschedule']>[0]): ReturnType<AnalyticsJobsAPI['unschedule']>;
  analyticsJobCreate(siteId: string, input: Parameters<AnalyticsJobsAPI['create']>[0]): ReturnType<AnalyticsJobsAPI['create']>;
  analyticsJobStatus(siteId: string, input: Parameters<AnalyticsJobsAPI['status']>[0]): ReturnType<AnalyticsJobsAPI['status']>;
  analyticsJobPage(siteId: string, input: Parameters<AnalyticsJobsAPI['page']>[0]): Promise<string>;
  analyticsJobCancel(siteId: string, input: Parameters<AnalyticsJobsAPI['cancel']>[0]): ReturnType<AnalyticsJobsAPI['cancel']>;

  getPublishedPolicy(siteId: string, experimentId: string, maxAgeMs?: number): Promise<PublishedPolicy>;
  ingest(events: readonly EventEnvelope[]): Promise<void>;
  createExperiment(siteId: string, input: CreateExperiment): Promise<Experiment>;
  getExperiment(siteId: string, experimentId: string): Promise<Experiment>;
  listExperiments(siteId: string, after?: string, limit?: number): Promise<string[]>;
  updateExperiment(siteId: string, experimentId: string, settings: Partial<ExperimentSettings>): Promise<Experiment>;
  addArm(siteId: string, experimentId: string, armId: string): Promise<Experiment>;
  setArmStatus(siteId: string, experimentId: string, armId: string, status: ArmStatus): Promise<Experiment>;
  setExperimentStatus(siteId: string, experimentId: string, status: ArmStatus): Promise<Experiment>;
  getPolicy(siteId: string, experimentId: string): Promise<PolicySnapshot>;
  createGoal(siteId: string, goalId: string): Promise<GoalDefinition>;
  getGoal(siteId: string, goalId: string): Promise<GoalDefinition | null>;
  listGoals(siteId: string, after?: string, limit?: number): Promise<GoalDefinition[]>;
  setGoalStatus(siteId: string, goalId: string, status: GoalStatus): Promise<GoalDefinition>;
  analyticsArmSeries(siteId: string, query: Parameters<AnalyticsAPI['armSeries']>[0]): ReturnType<AnalyticsAPI['armSeries']>;
  analyticsTraffic(siteId: string, query: Parameters<AnalyticsAPI['traffic']>[0]): ReturnType<AnalyticsAPI['traffic']>;
  analyticsPolicies(siteId: string, query: Parameters<AnalyticsAPI['policies']>[0]): ReturnType<AnalyticsAPI['policies']>;
  analyticsAttributeKeys(siteId: string, query: Parameters<AnalyticsAPI['attributeKeys']>[0]): ReturnType<AnalyticsAPI['attributeKeys']>;
  analyticsLearning(siteId: string, query: Parameters<AnalyticsAPI['learning']>[0]): ReturnType<AnalyticsAPI['learning']>;
  analyticsArms(siteId: string, query: Parameters<AnalyticsAPI['arms']>[0]): ReturnType<AnalyticsAPI['arms']>;
  analyticsTimeline(siteId: string, query: Parameters<AnalyticsAPI['timeline']>[0]): ReturnType<AnalyticsAPI['timeline']>;
  analyticsEvents(siteId: string, query: Parameters<AnalyticsAPI['events']>[0]): ReturnType<AnalyticsAPI['events']>;
  analyticsGoals(siteId: string, query: Parameters<AnalyticsAPI['goals']>[0]): ReturnType<AnalyticsAPI['goals']>;
  analyticsSeries(siteId: string, query: Parameters<AnalyticsAPI['series']>[0]): ReturnType<AnalyticsAPI['series']>;
  analyticsAttributeValues(siteId: string, query: Parameters<AnalyticsAPI['attributeValues']>[0]): ReturnType<AnalyticsAPI['attributeValues']>;
}
/** 실제 적용·노출 가능한 결정. decide/prepare의 status를 확인해 좁히고 원본 객체를 expose에 전달한다. */
export type AssignedDecision = Extract<Decision, { status: 'assigned' }>;
export type { Assignment, GoalDefinition };
