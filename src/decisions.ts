import { invariant } from './core/errors.js';
import { leaseRefreshAt } from './core/lease.js';
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
  /** 서비스 바인딩별 모듈 범위 캐시. 생략하면 바인딩 객체 기준 내부 캐시를 사용한다. */
  cache?: DecisionCache;
  /** 기본 60000ms, 양의 정수. 이후에는 오래된 정책을 재사용하면서 갱신한다. */
  freshMs?: number;
  /** 기본 300000ms, freshMs 이상 정수. 발행 시각부터 이 나이를 넘으면 미참여한다. */
  maxAgeMs?: number;
  /** 로컬 결정마다 동기 호출. 미참여율 측정용이며 느린 I/O를 여기서 기다리지 않는다. */
  onDecision?: (metric: DecisionMetric) => void;
  /** 미준비 상태와 만료가 가까운 토큰을 백그라운드에서 준비·갱신한다. 다음 요청이 읽을 서버 세션에 저장한다. 응답 반환 후 헤더는 수정할 수 없다. */
  onPrepared?: (experimentId: string, token: string) => Promise<void> | void;
}
/** 정책만 저장하는 isolate 캐시. capacity 기본 1000, 양의 정수. 호스트는 생성 후 decisions.cache에 전달하며 read/begin/put은 SDK 내부 갱신용이다. */
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
  const pendingPreparations = new Set<string>();
  const background = (work: Promise<unknown>) => ctx.waitUntil(work.catch(report));
  const refresh = (experimentId: string) => {
    if (cache.begin(key(experimentId), Date.now())) background(service.getPublishedPolicy(siteId, experimentId).then(policy => { cache.put(key(experimentId), policy); }));
  };
  const prepare = async (subject: Subject, experimentId: string, previousUntil?: number): Promise<PreparedDecision & { token: string | null }> => {
    invariant(options, 'invalid_input', 'Configure decisions.secret before preparing reusable state');
    const prepared = await service.prepareDecision(siteId, subject, experimentId);
    cache.put(key(experimentId), prepared.policy);
    if (prepared.decision.status !== 'assigned') return { ...prepared, token: null };
    const payload = b64(encoder.encode(JSON.stringify({ siteId, subject: subjectKey(siteId, subject), experimentId, until: prepared.reuseUntil, refreshAt: previousUntil === prepared.reuseUntil ? prepared.reuseUntil : leaseRefreshAt(Date.now(), prepared.reuseUntil), decision: prepared.decision })));
    const signature = b64(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(options.secret), encoder.encode(payload))));
    const token = `${payload}.${signature}`;
    invariant(token.length <= 16_384, 'invalid_input', 'Prepared state exceeds 16 KiB; use server-side sessions');
    localTokens.set(experimentId, token);
    return { ...prepared, token };
  };
  const prepareInBackground = (subject: Subject, experimentId: string, previousUntil?: number) => {
    if (!options?.onPrepared || preparing.has(experimentId)) return;
    preparing.add(experimentId);
    pendingPreparations.add(experimentId);
    const previous = localTokens.get(experimentId) ?? options.tokens?.[experimentId];
    background(prepare(subject, experimentId, previousUntil).then(async result => {
      if (result.token && result.token !== previous) await options.onPrepared!(experimentId, result.token);
    }).catch(error => {
      const policy = cache.read(key(experimentId));
      if (!policy || Date.now() - policy.publishedAt >= fresh) refresh(experimentId);
      throw error;
    }).finally(() => { pendingPreparations.delete(experimentId); }));
  };
  const decide = async (subject: Subject, experimentId: string): Promise<Decision> => {
    const now = Date.now(), policy = cache.read(key(experimentId));
    const age = policy ? now - policy.publishedAt : Infinity;
    const token = localTokens.get(experimentId) ?? options?.tokens?.[experimentId];
    const finish = (decision: Decision, reason: DecisionMetric['reason']) => {
      // Preparation supplies the policy too. Existing tokens must still warm
      // a missing/expired policy independently of a slow Subject/identity RPC.
      const needsIndependentPolicy = token !== undefined && (!policy || age >= maxAge);
      if ((!policy || age >= fresh) && (needsIndependentPolicy || !pendingPreparations.has(experimentId))) refresh(experimentId);
      try { options?.onDecision?.({ experimentId, outcome: decision.status === 'unavailable' ? 'skipped' : decision.status, reason, authenticated: subject.uid !== undefined, at: now }); } catch (error) { report(error); }
      return decision;
    };
    const skip = (reason: DecisionMetric['reason']) => {
      prepareInBackground(subject, experimentId);
      return finish({ status: 'unavailable', experimentId }, reason);
    };
    if (!policy) return skip('cold');
    if (age < 0 || age >= maxAge) return skip('expired');
    if (policy.status !== 'active' || policy.activeArms.length === 0) return finish({ status: 'no_active_arm', experimentId }, 'inactive');
    if (!options || !token) return skip('unprepared');
    try {
      invariant(token.length <= 16_384, 'invalid_input', 'State is too large');
      const parts = token.split('.');
      invariant(parts.length === 2, 'invalid_input', 'Malformed state');
      invariant(await crypto.subtle.verify('HMAC', await signingKey(options.secret), unb64(parts[1]!), encoder.encode(parts[0]!)), 'invalid_input', 'Invalid state signature');
      const state = record(JSON.parse(new TextDecoder().decode(unb64(parts[0]!))), 'state');
      const until = timestamp(state.until, 'until');
      invariant(state.siteId === siteId && state.subject === subjectKey(siteId, subject) && state.experimentId === experimentId && until > Date.now(), 'invalid_input', 'State scope or expiry mismatch');
      const raw = record(state.decision, 'decision'), assignment = parseAssignment(raw.assignment);
      invariant(assignment.experimentId === experimentId && typeof raw.routingKey === 'string', 'invalid_input', 'Invalid prepared assignment');
      if (!policy.activeArms.includes(assignment.armId)) return skip('inactive');
      const refreshAt = state.refreshAt === undefined ? until - fresh : timestamp(state.refreshAt, 'refreshAt');
      if (Date.now() >= refreshAt) prepareInBackground(subject, experimentId, until);
      return finish({ status: 'assigned', assignment, routingKey: raw.routingKey, reason: 'held' }, age < fresh ? 'fresh' : 'stale');
    } catch { return skip('invalid_state'); }
  };
  return { decide, prepare };
}
