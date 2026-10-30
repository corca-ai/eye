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
  /** Automatically generated runtime identity; prevents cross-installation decision reuse. */
  installationId: string;
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
  /** Runtime-generated identity for server-side receipt verification; never configured by the caller. */
  getInstallationId(): Promise<string>;
  hourlyGoalStatus(): ReturnType<SummariesAPI['hours']>;
  hourlyGoals(input: Parameters<SummariesAPI['series']>[0]): ReturnType<SummariesAPI['series']>;
  configureSummaries(input: Parameters<SummariesAPI['configure']>[0]): ReturnType<SummariesAPI['configure']>;
  summaryStatus(): ReturnType<SummariesAPI['status']>;
  querySummary(input: Parameters<SummariesAPI['query']>[0]): ReturnType<SummariesAPI['query']>;
  analyticsJobSchedule(input: Parameters<AnalyticsJobsAPI['schedule']>[0]): ReturnType<AnalyticsJobsAPI['schedule']>;
  analyticsJobScheduled(input: Parameters<AnalyticsJobsAPI['scheduled']>[0]): ReturnType<AnalyticsJobsAPI['scheduled']>;
  analyticsJobUnschedule(input: Parameters<AnalyticsJobsAPI['unschedule']>[0]): ReturnType<AnalyticsJobsAPI['unschedule']>;
  analyticsJobCreate(input: Parameters<AnalyticsJobsAPI['create']>[0]): ReturnType<AnalyticsJobsAPI['create']>;
  analyticsJobStatus(input: Parameters<AnalyticsJobsAPI['status']>[0]): ReturnType<AnalyticsJobsAPI['status']>;
  analyticsJobPage(input: Parameters<AnalyticsJobsAPI['page']>[0]): Promise<string>;
  analyticsJobCancel(input: Parameters<AnalyticsJobsAPI['cancel']>[0]): ReturnType<AnalyticsJobsAPI['cancel']>;

  getPublishedPolicy(experimentId: string, maxAgeMs?: number): Promise<PublishedPolicy>;
  ingest(events: readonly Omit<EventEnvelope, 'siteId'>[]): Promise<void>;
  createExperiment(input: CreateExperiment): Promise<Experiment>;
  getExperiment(experimentId: string): Promise<Experiment>;
  listExperiments(after?: string, limit?: number): Promise<string[]>;
  updateExperiment(experimentId: string, settings: Partial<ExperimentSettings>): Promise<Experiment>;
  addArm(experimentId: string, armId: string): Promise<Experiment>;
  setArmStatus(experimentId: string, armId: string, status: ArmStatus): Promise<Experiment>;
  setExperimentStatus(experimentId: string, status: ArmStatus): Promise<Experiment>;
  getPolicy(experimentId: string): Promise<PolicySnapshot>;
  createGoal(goalId: string): Promise<GoalDefinition>;
  getGoal(goalId: string): Promise<GoalDefinition | null>;
  listGoals(after?: string, limit?: number): Promise<GoalDefinition[]>;
  setGoalStatus(goalId: string, status: GoalStatus): Promise<GoalDefinition>;
  analyticsArmSeries(query: Parameters<AnalyticsAPI['armSeries']>[0]): ReturnType<AnalyticsAPI['armSeries']>;
  analyticsTraffic(query: Parameters<AnalyticsAPI['traffic']>[0]): ReturnType<AnalyticsAPI['traffic']>;
  analyticsPolicies(query: Parameters<AnalyticsAPI['policies']>[0]): ReturnType<AnalyticsAPI['policies']>;
  analyticsAttributeKeys(query: Parameters<AnalyticsAPI['attributeKeys']>[0]): ReturnType<AnalyticsAPI['attributeKeys']>;
  analyticsLearning(query: Parameters<AnalyticsAPI['learning']>[0]): ReturnType<AnalyticsAPI['learning']>;
  analyticsArms(query: Parameters<AnalyticsAPI['arms']>[0]): ReturnType<AnalyticsAPI['arms']>;
  analyticsTimeline(query: Parameters<AnalyticsAPI['timeline']>[0]): ReturnType<AnalyticsAPI['timeline']>;
  analyticsEventSeries(query: Parameters<AnalyticsAPI['eventSeries']>[0]): ReturnType<AnalyticsAPI['eventSeries']>;
  analyticsEventList(query: Parameters<AnalyticsAPI['eventList']>[0]): ReturnType<AnalyticsAPI['eventList']>;
  analyticsEvents(query: Parameters<AnalyticsAPI['events']>[0]): ReturnType<AnalyticsAPI['events']>;
  analyticsGoals(query: Parameters<AnalyticsAPI['goals']>[0]): ReturnType<AnalyticsAPI['goals']>;
  analyticsSeries(query: Parameters<AnalyticsAPI['series']>[0]): ReturnType<AnalyticsAPI['series']>;
  analyticsAttributeValues(query: Parameters<AnalyticsAPI['attributeValues']>[0]): ReturnType<AnalyticsAPI['attributeValues']>;
}
/** 실제 적용·노출 가능한 결정. decide/prepare의 status를 확인해 좁히고 원본 객체를 expose에 전달한다. */
export type AssignedDecision = Extract<Decision, { status: 'assigned' }>;
export type { Assignment, GoalDefinition };
