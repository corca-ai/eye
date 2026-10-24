import { DEFAULT_POLICY_MAX_AGE_MS, policyFreshMs } from './policy-timing.js';
import { createEye, type EyeOptions } from './client.js';
import { parseAssignment } from './core/events.js';
import { parseLocalContext } from './decisions.js';
import type { LocalAssignmentContext } from './core/local-assignment.js';
import { attributes, id, record, subject as parseSubject, timestamp } from './core/validation.js';
import { invariant } from './core/errors.js';
import type { Attributes, Subject } from './core/types.js';
import type { AssignedDecision } from './transport.js';
import type { BrowserSnapshot, BrowserEventResult } from './browser-types.js';

export interface BrowserServerOptions extends EyeOptions {
  subject: Subject;
  /** Host-authenticated browser binding, stable across login/logout, never taken from request JSON. */
  browserBinding: string;
  /** Host authentication epoch; rotate on every login/logout/account switch. */
  scope: string;
  /** Secret of at least 32 UTF-8 bytes; kept on server. Domain-separated from decision signing. */
  receiptSecret: string;
  userAttributes?: Attributes;
}
const encoder = new TextEncoder();
const grace = 300_000;
function encode(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function decode(text: string) { return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }

/** Request-scoped adapter. Mount behind host authentication and same-origin POST checks. */
export function createEyeBrowserServer(options: BrowserServerOptions) {
  const eye = createEye(options), subject = parseSubject(options.subject);
  const binding = id(options.browserBinding, 'browserBinding'), scope = id(options.scope, 'scope');
  const audience = encoder.encode(`eye/browser-exposure/v1/${options.siteId}`);
  let importedKey: Promise<CryptoKey> | undefined;
  const importKey = async () => {
    invariant(encoder.encode(options.receiptSecret).length >= 32, 'invalid_input', 'receiptSecret requires 32 bytes');
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`eye/browser-exposure/v1/${options.receiptSecret}`));
    return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
  };
  const key = () => importedKey ??= importKey();
  const seal = async (value: unknown) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: audience }, await key(), encoder.encode(JSON.stringify(value)));
    return `${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
  };
  const openReceipt = async (receipt: unknown) => {
    invariant(typeof receipt === 'string' && receipt.length <= 24_000, 'invalid_input', 'Invalid receipt');
    const parts = receipt.split('.'); invariant(parts.length === 2, 'invalid_input', 'Invalid receipt');
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(parts[0]!), additionalData: audience }, await key(), decode(parts[1]!));
    const value = record(JSON.parse(new TextDecoder().decode(clear)), 'receipt');
    invariant(value.binding === binding, 'invalid_input', 'Receipt browser mismatch');
    return value;
  };
  const withSample = (context: LocalAssignmentContext, sample: unknown) => sample === undefined ? context : parseLocalContext({ ...context, sample });
  return {
    /** Explicit waiting route; call after rendering or during host data loading, never from synchronous browser selection. Up to 20 experiments. */
    async prepare(experimentIds: readonly string[], previous: unknown = {}): Promise<BrowserSnapshot> {
      invariant(experimentIds.length <= 20, 'invalid_input', 'At most 20 experiments per preparation');
      const states = record(previous, 'states');
      const choices: BrowserSnapshot['choices'] = [];
      for (const experimentId of new Set(experimentIds)) {
        try {
          let context: LocalAssignmentContext | undefined;
          if (Object.hasOwn(states, experimentId)) {
            try {
              const state = record(states[experimentId], 'browser state'), receipt = await openReceipt(state.receipt);
              invariant(receipt.scope === scope, 'invalid_input', 'Previous authentication scope');
              const prior = record(receipt.decision, 'decision');
              context = withSample(parseLocalContext(prior.localContext), state.sample);
              invariant(context.subject.cid === subject.cid && context.subject.uid === subject.uid
                && context.assignment.experimentId === experimentId && (context.sample?.startAt ?? 0) <= Date.now(), 'invalid_input', 'Previous state mismatch');
            } catch (error) { context = undefined; try { options.onError?.(error); } catch { /* host hook */ } }
          }
          const prepared = await eye.prepare({ subject, experimentId, ...(context === undefined ? {} : { context }) });
          if (prepared.decision.status !== 'assigned') continue;
          const issuedAt = Date.now();
          const applyUntil = Math.min(prepared.reuseUntil, prepared.policy.publishedAt + (options.decisions?.maxAgeMs ?? DEFAULT_POLICY_MAX_AGE_MS));
          if (applyUntil <= issuedAt || !prepared.policy.activeArms.includes(prepared.decision.assignment.armId) || prepared.policy.status !== 'active') continue;
          const receipt = await seal({ binding, scope, subject, decision: prepared.decision, issuedAt, applyUntil,
            userAttributes: options.userAttributes ?? {} });
          choices.push({ experimentId, armId: prepared.decision.assignment.armId, applyUntil, receipt,
            refreshAfter: Math.min(applyUntil, issuedAt + policyFreshMs(options.decisions)),
            assignmentId: prepared.decision.assignment.assignmentId, observationWindowMs: prepared.decision.assignment.settings.observationWindowMs,
            ...(prepared.decision.localContext?.sample === undefined ? {} : { sample: prepared.decision.localContext.sample }) });
        } catch (error) { try { options.onError?.(error); } catch { /* host hook */ } }
      }
      return { scope, serverNow: Date.now(), choices };
    },
    /** Accept original identity from authenticated receipts, even after host auth changes. Waits for Queue ingestion, not analytics. Body cap must also be enforced by the HTTP host. */
    async receive(input: unknown): Promise<BrowserEventResult[]> {
      invariant(Array.isArray(input) && input.length <= 50, 'invalid_input', 'At most 50 exposures per batch');
      invariant(encoder.encode(JSON.stringify(input)).length <= 48_000, 'invalid_input', 'Exposure batch exceeds 48 KB');
      const results: BrowserEventResult[] = [];
      const pending: { index: number; input: Parameters<typeof eye.expose>[0] }[] = [];
      let futureClock = false;
      for (const raw of input) {
        let eventId = '';
        try {
          const event = record(raw, 'exposure'); eventId = id(event.eventId, 'eventId');
          const receipt = await openReceipt(event.receipt);
          const issuedAt = timestamp(receipt.issuedAt, 'issuedAt'), until = timestamp(receipt.applyUntil, 'applyUntil');
          const at = timestamp(event.occurredAt, 'occurredAt'), now = Date.now();
          invariant(receipt.binding === binding && at >= issuedAt && at < until && now <= until + grace && at <= now + 5000,
            'invalid_input', 'Receipt binding or time mismatch');
          if (at > now) { futureClock = true; results.push({ eventId, accepted: false }); continue; }
          const decision = record(receipt.decision, 'decision');
          const localContext = withSample(parseLocalContext(decision.localContext), event.sample);
          const assigned: AssignedDecision = { status: 'assigned', reason: 'held', assignment: parseAssignment(decision.assignment), localContext, applyUntil: until };
          pending.push({ index: results.length, input: { subject: parseSubject(receipt.subject), decision: assigned,
            eventId, occurredAt: at, userAttributes: attributes(receipt.userAttributes) } });
          results.push({ eventId, accepted: false });
        } catch (error) {
          try { options.onError?.(error); } catch { /* host hook */ }
          results.push({ eventId, accepted: false });
        }
      }
      // Retry small future skew without changing the event's canonical timestamp.
      invariant(!futureClock, 'unavailable', 'Exposure clock is ahead; retry unchanged');
      // No await between submissions: one flush observes every ingestion in this batch.
      for (const entry of pending) results[entry.index]!.accepted = eye.expose(entry.input).accepted;
      await eye.flush();
      return results;
    },
  };
}
