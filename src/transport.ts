import type { ArmStatus, Assignment, CreateExperiment, Decision, EventEnvelope, Experiment, ExperimentSettings, GoalStatus, Subject } from './core/types.js';
import type { GoalDefinition } from './runtime/site.js';
import type { PolicyEvaluation } from './core/policy.js';
import type { AnalyticsAPI } from './analytics/types.js';

/** statsAsOf는 보유 shard snapshot들의 최소 시각이며 null은 snapshot 없음. 전체 데이터 수신 완료 watermark가 아니다. */
export interface PolicySnapshot extends PolicyEvaluation {
  experimentId: string; generation: number; revision: number; statsAsOf: number | null;
}
export interface PublishedPolicy extends PolicySnapshot {
  publishedAt: number; sequence: number; status: ArmStatus; activeArms: string[];
}
/** reuseUntil은 배정 토큰 재사용 만료 Unix 밀리초. 명시적 prepare 결과에는 token도 추가된다. */
export interface PreparedDecision { decision: Decision; reuseUntil: number; policy: PublishedPolicy }
/** Structural RPC contract: hosts may name their Service Binding freely. */
export interface EyeService {
  getPublishedPolicy(siteId: string, experimentId: string): Promise<PublishedPolicy>;
  prepareDecision(siteId: string, subject: Subject, experimentId: string): Promise<PreparedDecision>;
  decide(siteId: string, subject: Subject, experimentId: string): Promise<Decision>;
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
  analyticsArms(siteId: string, query: Parameters<AnalyticsAPI['arms']>[0]): ReturnType<AnalyticsAPI['arms']>;
  analyticsTimeline(siteId: string, query: Parameters<AnalyticsAPI['timeline']>[0]): ReturnType<AnalyticsAPI['timeline']>;
  analyticsGoals(siteId: string, query: Parameters<AnalyticsAPI['goals']>[0]): ReturnType<AnalyticsAPI['goals']>;
  analyticsSeries(siteId: string, query: Parameters<AnalyticsAPI['series']>[0]): ReturnType<AnalyticsAPI['series']>;
  analyticsAttributeValues(siteId: string, query: Parameters<AnalyticsAPI['attributeValues']>[0]): ReturnType<AnalyticsAPI['attributeValues']>;
}
export type AssignedDecision = Extract<Decision, { status: 'assigned' }>;
export type { Assignment, GoalDefinition };
