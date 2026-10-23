import { invariant } from './core/errors.js';
import { parseAssignment } from './core/events.js';
import { record, timestamp, subjectKey } from './core/validation.js';
import type { Decision, Subject } from './core/types.js';
import type { EyeService, PublishedPolicy, PreparedDecision } from './transport.js';

export interface DecisionMetric {
  experimentId: string; outcome: 'assigned' | 'skipped' | 'no_active_arm';
  reason: 'fresh' | 'stale' | 'cold' | 'expired' | 'unprepared' | 'invalid_state' | 'inactive';
  authenticated: boolean; at: number;
}
export interface DecisionOptions {
  /** Host secret, at least 32 UTF-8 bytes; never send it to browsers. */
  secret: string;
  /** State from a host session or signed cookie, keyed by experiment ID. */
  tokens?: Readonly<Record<string, string>>;
  cache?: DecisionCache;
  freshMs?: number;
  maxAgeMs?: number;
  onDecision?: (metric: DecisionMetric) => void;
  /** Persist through a server session; response headers cannot be changed after return. */
  onPrepared?: (experimentId: string, token: string) => Promise<void> | void;
}
/** Isolate-local policy cache only: no subjects, tokens, or cross-request I/O promises. */
export class DecisionCache {
  private readonly entries = new Map<string, { policy?: PublishedPolicy; retryAt: number }>();
  constructor(private readonly capacity = 1000) { invariant(Number.isSafeInteger(capacity) && capacity > 0, 'invalid_input', 'Invalid policy cache capacity'); }
  read(key: string): PublishedPolicy | undefined { return this.entries.get(key)?.policy; }
  begin(key: string, now: number): boolean {
    if ((this.entries.get(key)?.retryAt ?? 0) > now) return false;
    const entry = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, { ...entry, retryAt: now + 10_000 });
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return true;
  }
  put(key: string, policy: PublishedPolicy): void {
    const old = this.entries.get(key);
    if (old?.policy && old.policy.sequence >= policy.sequence) return;
    this.entries.set(key, { policy, retryAt: 0 });
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }
}
type DecisionService = Pick<EyeService, 'getPublishedPolicy' | 'prepareDecision'>;
const caches = new WeakMap<DecisionService, DecisionCache>();
const encoder = new TextEncoder();
function b64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function unb64(text: string): Uint8Array { return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
async function signingKey(secret: string): Promise<CryptoKey> {
  invariant(encoder.encode(secret).length >= 32, 'invalid_input', 'Decision secret must contain at least 32 UTF-8 bytes');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export function decisionRuntime(service: DecisionService, ctx: Pick<ExecutionContext, 'waitUntil'>, siteId: string, options: DecisionOptions | undefined, report: (error: unknown) => void) {
  let shared = caches.get(service);
  if (!shared) { shared = new DecisionCache(); caches.set(service, shared); }
  const cache = options?.cache ?? shared;
  const fresh = options?.freshMs ?? 60_000, maxAge = options?.maxAgeMs ?? 300_000;
  invariant(fresh > 0 && Number.isSafeInteger(fresh) && Number.isSafeInteger(maxAge) && maxAge >= fresh, 'invalid_input', 'Invalid policy freshness settings');
  const key = (experimentId: string) => JSON.stringify([siteId, experimentId]);
  const localTokens = new Map<string, string>();
  const preparing = new Set<string>();
  const background = (work: Promise<unknown>) => ctx.waitUntil(work.catch(report));
  const refresh = (experimentId: string) => {
    if (cache.begin(key(experimentId), Date.now())) background(service.getPublishedPolicy(siteId, experimentId).then(policy => { cache.put(key(experimentId), policy); }));
  };
  const prepare = async (subject: Subject, experimentId: string): Promise<PreparedDecision & { token: string | null }> => {
    invariant(options, 'invalid_input', 'Configure decisions.secret before preparing reusable state');
    const prepared = await service.prepareDecision(siteId, subject, experimentId);
    cache.put(key(experimentId), prepared.policy);
    if (prepared.decision.status !== 'assigned') return { ...prepared, token: null };
    const payload = b64(encoder.encode(JSON.stringify({ siteId, subject: subjectKey(siteId, subject), experimentId, until: prepared.reuseUntil, decision: prepared.decision })));
    const signature = b64(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(options.secret), encoder.encode(payload))));
    const token = `${payload}.${signature}`;
    invariant(token.length <= 16_384, 'invalid_input', 'Prepared state exceeds 16 KiB; use server-side sessions');
    localTokens.set(experimentId, token);
    return { ...prepared, token };
  };
  const decide = async (subject: Subject, experimentId: string): Promise<Decision> => {
    const now = Date.now(), policy = cache.read(key(experimentId));
    const age = policy ? now - policy.publishedAt : Infinity;
    if (!policy || age >= fresh) refresh(experimentId);
    const finish = (decision: Decision, reason: DecisionMetric['reason']) => {
      try { options?.onDecision?.({ experimentId, outcome: decision.status === 'unavailable' ? 'skipped' : decision.status, reason, authenticated: subject.uid !== undefined, at: now }); } catch (error) { report(error); }
      return decision;
    };
    const skip = (reason: DecisionMetric['reason']) => {
      if (options?.onPrepared && !preparing.has(experimentId)) {
        preparing.add(experimentId);
        background(prepare(subject, experimentId).then(async result => { if (result.token) await options.onPrepared!(experimentId, result.token); }));
      }
      return finish({ status: 'unavailable', experimentId }, reason);
    };
    if (!policy) return skip('cold');
    if (age < 0 || age >= maxAge) return skip('expired');
    if (policy.status !== 'active' || policy.activeArms.length === 0) return finish({ status: 'no_active_arm', experimentId }, 'inactive');
    const token = localTokens.get(experimentId) ?? options?.tokens?.[experimentId];
    if (!options || !token) return skip('unprepared');
    try {
      invariant(token.length <= 16_384, 'invalid_input', 'State is too large');
      const parts = token.split('.');
      invariant(parts.length === 2, 'invalid_input', 'Malformed state');
      invariant(await crypto.subtle.verify('HMAC', await signingKey(options.secret), unb64(parts[1]!), encoder.encode(parts[0]!)), 'invalid_input', 'Invalid state signature');
      const state = record(JSON.parse(new TextDecoder().decode(unb64(parts[0]!))), 'state');
      invariant(state.siteId === siteId && state.subject === subjectKey(siteId, subject) && state.experimentId === experimentId && timestamp(state.until, 'until') > Date.now(), 'invalid_input', 'State scope or expiry mismatch');
      const raw = record(state.decision, 'decision'), assignment = parseAssignment(raw.assignment);
      invariant(assignment.experimentId === experimentId && typeof raw.routingKey === 'string', 'invalid_input', 'Invalid prepared assignment');
      if (!policy.activeArms.includes(assignment.armId)) return skip('inactive');
      return finish({ status: 'assigned', assignment, routingKey: raw.routingKey, reason: 'held' }, age < fresh ? 'fresh' : 'stale');
    } catch { return skip('invalid_state'); }
  };
  return { decide, prepare };
}
