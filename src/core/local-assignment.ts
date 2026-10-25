import { compareIdentifiers } from './attribution.js';
import type { SampleExposure } from './closed-cohort.js';
import { invariant } from './errors.js';
import { chooseArm } from './policy.js';
import { observationEndAt } from './sample-context.js';
import type { Assignment, ExperimentSettings, Subject } from './types.js';

/** Validated cached policy: freshUntil starts background refresh; usableUntil
 * stops NEW applications. A currently rendered view is not silently replaced.
 */
export interface LocalPolicy {
  readonly siteId: string;
  readonly experimentId: string;
  readonly generation: number;
  readonly revision: number;
  readonly sequence: number;
  readonly publishedAt: number;
  readonly freshUntil: number;
  readonly usableUntil: number;
  readonly active: boolean;
  readonly arms: readonly { readonly armId: string; readonly probability: number }[];
  readonly settings: ExperimentSettings;
  readonly attributionWindowMs: number;
}
/** Internal trusted context. The host adapter must verify its signature before
 * passing persisted client data here, and persist returned updates after exposure.
 */
export interface LocalAssignmentContext {
  readonly siteId: string;
  readonly subject: Subject;
  readonly assignment: Assignment;
  readonly drawIndex: number;
  readonly attributionWindowMs: number;
  readonly sample?: { readonly sampleId: string; readonly startAt: number };
}
export type LocalSelection =
  | { readonly status: 'unavailable' | 'no_active_arm'; readonly refreshPolicy: boolean }
  | { readonly status: 'assigned'; readonly refreshPolicy: boolean; readonly reason: 'selected' | 'held';
      readonly context: LocalAssignmentContext; readonly applyUntil: number };
export interface LocalSelectionInput {
  readonly siteId: string;
  readonly experimentId: string;
  readonly subject: Subject;
  readonly now: number;
  readonly policy?: LocalPolicy;
  readonly previous?: LocalAssignmentContext;
  /** Unique ID for a new assignment, generated only if selection is needed. */
  readonly newId: () => string;
}

/** Synchronous, zero I/O. The adapter schedules requested refresh with waitUntil;
 * cache misses fail open to the host's fallback instead of waiting for a policy.
 */
export function selectLocal(input: LocalSelectionInput): LocalSelection {
  const { siteId, experimentId, subject, now, policy, previous } = input;
  invariant(Number.isSafeInteger(now) && now >= 0, 'invalid_input', 'Invalid selection time');
  if (!policy || policy.siteId !== siteId || policy.experimentId !== experimentId
    || policy.publishedAt > now || now >= policy.usableUntil) return { status: 'unavailable', refreshPolicy: true };
  const refreshPolicy = now >= policy.freshUntil;
  if (!policy.active || policy.arms.length === 0) return { status: 'no_active_arm', refreshPolicy };
  const sameContext = previous?.siteId === siteId && previous.assignment.experimentId === experimentId
    && previous.subject.cid === subject.cid && previous.subject.uid === subject.uid;
  if (sameContext) {
    // Do not validate an old held context against an even older policy snapshot.
    if (previous.assignment.policyRevision > policy.revision) return { status: 'unavailable', refreshPolicy: true };
    const endAt = previous.sample === undefined ? 0
      : observationEndAt(previous.sample.startAt, previous.assignment.settings.observationWindowMs);
    const heldUntil = Math.max(previous.assignment.assignedAt + previous.assignment.settings.minHoldMs, endAt);
    if (now < heldUntil && policy.arms.some(a => a.armId === previous.assignment.armId)) {
      return { status: 'assigned', refreshPolicy, reason: 'held', context: previous, applyUntil: Math.min(policy.usableUntil, heldUntil) };
    }
  }
  const drawIndex = sameContext ? previous.drawIndex + 1 : 0;
  invariant(Number.isSafeInteger(drawIndex), 'invalid_input', 'Selection counter overflow');
  const arms = [...policy.arms].sort((a, b) => compareIdentifiers(a.armId, b.armId));
  const owner = subject.uid === undefined ? ['cid', subject.cid] : ['uid', subject.uid];
  const random = selectionUnit(JSON.stringify([siteId, experimentId, owner, policy.sequence, drawIndex]));
  const chosen = chooseArm({ arms }, random)!;
  const assignment: Assignment = {
    assignmentId: input.newId(), experimentId, armId: chosen.armId, generation: policy.generation,
    assignedAt: now, policyRevision: policy.revision, probability: chosen.probability, settings: policy.settings,
  };
  return { status: 'assigned', refreshPolicy, reason: 'selected', applyUntil: policy.usableUntil,
    context: { siteId, subject: { ...subject }, assignment, drawIndex, attributionWindowMs: policy.attributionWindowMs } };
}

/** Called only for a real application/visible exposure. Opening a sample updates
 * the caller's local context without remote I/O.
 * An exposure handle must reuse eventId on retry and de-duplicate repeated calls.
 */
export function exposeLocal(selection: Extract<LocalSelection, { status: 'assigned' }>, occurredAt: number, eventId: string): {
  readonly context: LocalAssignmentContext; readonly exposure: SampleExposure;
} {
  const previous = selection.context;
  invariant(Number.isSafeInteger(occurredAt) && occurredAt >= previous.assignment.assignedAt && occurredAt < selection.applyUntil,
    'invalid_input', 'Exposure outside the application interval');
  const sample = previous.sample && occurredAt >= previous.sample.startAt
    && occurredAt < observationEndAt(previous.sample.startAt, previous.assignment.settings.observationWindowMs)
    ? previous.sample : { sampleId: JSON.stringify([previous.assignment.assignmentId, eventId]), startAt: occurredAt };
  invariant(previous.sample === undefined || occurredAt >= previous.sample.startAt,
    'invalid_input', 'Local exposure cannot precede the current sample');
  const context: LocalAssignmentContext = sample === previous.sample ? previous : { ...previous, sample };
  return { context, exposure: {
    event: { kind: 'exposure', eventId, occurredAt, subject: previous.subject, assignment: previous.assignment },
    sampleId: sample.sampleId, startAt: sample.startAt, attributionWindowMs: previous.attributionWindowMs,
  } };
}

/** Fast non-cryptographic mixing for allocation, never an authentication mechanism.
 * Tuple encoding keeps namespaces distinct; avalanche finalization mixes
 * common sequential IDs. No per-user global seed/state is required.
 */
function selectionUnit(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { hash ^= key.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4_294_967_296;
}
