import type { ArmStatus, Assignment, CreateExperiment, Decision, EventEnvelope, Experiment, ExperimentSettings, GoalStatus, Subject } from './core/types.js';
import type { GoalDefinition } from './runtime/site.js';
import type { PolicyEvaluation } from './core/policy.js';
import type { AnalyticsAPI } from './analytics/types.js';

export interface PolicySnapshot extends PolicyEvaluation {
  experimentId: string; generation: number; revision: number; statsAsOf: number | null;
}
/** Structural RPC contract: hosts may name their Service Binding freely. */
export interface EyeService {
  decide(siteId: string, subject: Subject, experimentId: string): Promise<Decision>;
  ingest(events: readonly EventEnvelope[]): Promise<void>;
  createExperiment(siteId: string, input: CreateExperiment): Promise<Experiment>;
  getExperiment(siteId: string, experimentId: string): Promise<Experiment>;
  listExperiments(siteId: string, after?: string, limit?: number): Promise<string[]>;
  updateExperiment(siteId: string, experimentId: string, settings: Partial<ExperimentSettings>): Promise<Experiment>;
  addArm(siteId: string, experimentId: string, armId: string): Promise<Experiment>;
  setArmStatus(siteId: string, experimentId: string, armId: string, status: ArmStatus): Promise<Experiment>;
  getPolicy(siteId: string, experimentId: string): Promise<PolicySnapshot>;
  createGoal(siteId: string, goalId: string): Promise<GoalDefinition>;
  getGoal(siteId: string, goalId: string): Promise<GoalDefinition | null>;
  listGoals(siteId: string, after?: string, limit?: number): Promise<GoalDefinition[]>;
  setGoalStatus(siteId: string, goalId: string, status: GoalStatus): Promise<GoalDefinition>;
  analyticsArms(siteId: string, query: Parameters<AnalyticsAPI['arms']>[0]): ReturnType<AnalyticsAPI['arms']>;
  analyticsTimeline(siteId: string, query: Parameters<AnalyticsAPI['timeline']>[0]): ReturnType<AnalyticsAPI['timeline']>;
  analyticsGoals(siteId: string, query: Parameters<AnalyticsAPI['goals']>[0]): ReturnType<AnalyticsAPI['goals']>;
  analyticsSeries(siteId: string, query: Parameters<AnalyticsAPI['series']>[0]): ReturnType<AnalyticsAPI['series']>;
  analyticsAttributeValues(siteId: string, query: Parameters<AnalyticsAPI['attributeValues']>[0]): ReturnType<AnalyticsAPI['attributeValues']>;
}
export type AssignedDecision = Extract<Decision, { status: 'assigned' }>;
export type { Assignment, GoalDefinition };
