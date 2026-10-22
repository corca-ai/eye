/** Every timestamp is Unix milliseconds; every duration is milliseconds. */
export type Attributes = Readonly<Record<string, string | number | boolean | null>>;
export type Subject = { readonly cid: string; readonly uid?: string };
export type GoalStatus = 'active' | 'paused' | 'deleted';
export type ArmStatus = 'active' | 'paused';
export type ObservationStatus = 'pending' | 'complete' | 'interrupted';

export interface ExperimentSettings {
  readonly minHoldMs: number;
  readonly observationWindowMs: number;
  readonly attributionHalfLifeMs: number;
  readonly learningHalfLifeMs: number;
  readonly allowedLatenessMs: number;
  readonly explorationFloor: number;
  readonly rewardScale: number;
  readonly bonusMultiplier: number;
  readonly pendingPenalty: number;
  readonly bootstrapQuota: number;
  readonly reservationTtlMs: number;
}
export interface CreateExperiment {
  readonly experimentId: string;
  readonly arms: readonly string[];
  readonly settings: Pick<ExperimentSettings, 'minHoldMs'> & Partial<Omit<ExperimentSettings, 'minHoldMs'>>;
}
export interface Experiment {
  readonly experimentId: string;
  readonly generation: number;
  readonly revision: number;
  readonly createdAt: number;
  readonly settings: ExperimentSettings;
  readonly arms: readonly { readonly armId: string; readonly status: ArmStatus }[];
}
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
  | { readonly status: 'assigned'; readonly assignment: Assignment; readonly reason: 'selected' | 'held' | 'adopted'; readonly routingKey?: string }
  | { readonly status: 'no_active_arm' | 'unavailable'; readonly experimentId: string };

interface EventBase {
  readonly eventId: string;
  readonly occurredAt: number;
  readonly subject: Subject;
  readonly attributes?: Attributes;
}
export type TrackEvent = EventBase & { readonly kind: 'track'; readonly name: string };
export type GoalEvent = EventBase & { readonly kind: 'goal'; readonly goalId: string; readonly value: number };
export type ExposureEvent = EventBase & {
  readonly kind: 'exposure'; readonly assignment: Assignment; readonly userAttributes?: Attributes; readonly routingKey?: string;
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
  readonly interruptReason?: 'identity' | 'arm_stopped' | 'configuration';
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
}
