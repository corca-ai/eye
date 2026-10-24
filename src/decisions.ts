import { policyFreshMs, DEFAULT_POLICY_MAX_AGE_MS } from './policy-timing.js';
import { invariant } from './core/errors.js';
import { selectLocal, exposeLocal } from './core/local-assignment.js';
import type { LocalAssignmentContext, LocalSelection } from './core/local-assignment.js';
import { parseAssignment } from './core/events.js';
import { record, timestamp, id, subject as parseSubject, sampleId } from './core/validation.js';
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
  /** 기본 900000ms(15분), 양의 정수. 생략 시 더 짧은 maxAgeMs를 지정하면 그 절반 이하(최소 1ms)로 줄인다. 마지막 성공한 정책 확인 후 이 시간이 지나면 백그라운드 재확인한다. */
  freshMs?: number;
  /** 기본 21600000ms(6시간), freshMs 이상 정수. 발행 시각부터 이 나이를 넘으면 미참여한다. */
  maxAgeMs?: number;
  /** 로컬 결정마다 동기 호출. 미참여율 측정용이며 느린 I/O를 여기서 기다리지 않는다. */
  onDecision?: (metric: DecisionMetric) => void;
  /** 로컬 배정 또는 실제 노출로 상태가 바뀌면 서명 후 호출한다. 다음 요청이 읽을 서버 세션에 저장한다. 쿠키는 state()를 기다린 뒤 응답에 쓴다. */
  onPrepared?: (experimentId: string, token: string) => Promise<void> | void;
}
/** 정책만 저장하는 isolate 캐시. capacity 기본 1000, 양의 정수. 호스트는 생성 후 decisions.cache에 전달하며 read/checkedAt/begin/put은 SDK 내부 갱신용이다. */
export class DecisionCache {
  private readonly entries = new Map<string, { policy?: PublishedPolicy; retryAt: number; checkedAt?: number }>();
  constructor(private readonly capacity = 1000) { invariant(Number.isSafeInteger(capacity) && capacity > 0, 'invalid_input', 'Invalid policy cache capacity'); }
  read(key: string): PublishedPolicy | undefined { return this.entries.get(key)?.policy; }
  checkedAt(key: string): number | undefined { return this.entries.get(key)?.checkedAt; }
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
    if (old?.policy && old.policy.sequence > policy.sequence) return;
    this.entries.set(key, { policy: old?.policy?.sequence === policy.sequence ? old.policy : policy, retryAt: 0, checkedAt: Date.now() });
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }
}
type DecisionService = Pick<EyeService, 'getPublishedPolicy'>;
const caches = new WeakMap<DecisionService, DecisionCache>();
const encoder = new TextEncoder();
const policyLoads = new WeakMap<DecisionCache, Map<string, { work: Promise<PublishedPolicy>; expiresAt: number }>>();
function b64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function unb64(text: string): Uint8Array { return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
export function decisionRuntime(service: DecisionService, ctx: Pick<ExecutionContext, 'waitUntil'>, siteId: string, options: DecisionOptions | undefined, report: (error: unknown) => void) {
  let shared = caches.get(service);
  if (!shared) { shared = new DecisionCache(); caches.set(service, shared); }
  const cache = options?.cache ?? shared;
  const fresh = policyFreshMs(options), maxAge = options?.maxAgeMs ?? DEFAULT_POLICY_MAX_AGE_MS;
  invariant(fresh > 0 && Number.isSafeInteger(fresh) && Number.isSafeInteger(maxAge) && maxAge >= fresh, 'invalid_input', 'Invalid policy freshness settings');
  if (options) invariant(typeof options.secret === 'string' && encoder.encode(options.secret).length >= 32,
    'invalid_input', 'Configure a decision secret of at least 32 UTF-8 bytes');
  const contexts = new Map<string, LocalAssignmentContext>();
  const restored = new Map<string, Promise<void>>();
  const writes = new Map<string, Promise<string>>();
  const notifications = new Map<string, Promise<void>>();
  const tokens = new Map<string, string>();
  let cryptoKey: Promise<CryptoKey> | undefined;
  const signingKey = () => {
    invariant(options && encoder.encode(options.secret).length >= 32, 'invalid_input', 'Configure a decision secret of at least 32 UTF-8 bytes');
    return cryptoKey ??= crypto.subtle.importKey('raw', encoder.encode(options.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  };
  const key = (experimentId: string) => JSON.stringify([siteId, experimentId]);
  const background = (work: Promise<unknown>) => ctx.waitUntil(work.catch(report));
  const fetchPolicy = (experimentId: string, force = false): Promise<PublishedPolicy> => {
    let loads = policyLoads.get(cache);
    if (!loads) { loads = new Map(); policyLoads.set(cache, loads); }
    const loadKey = JSON.stringify([siteId, experimentId, maxAge]);
    const pending = loads.get(loadKey);
    if (!force && pending && pending.expiresAt > Date.now()) return pending.work;
    const work = (async () => {
      const policy = await service.getPublishedPolicy(siteId, experimentId, maxAge);
      cache.put(key(experimentId), policy);
      return cache.read(key(experimentId))!;
    })();
    if (!force) {
      loads.delete(loadKey);
      loads.set(loadKey, { work, expiresAt: Date.now() + 10_000 });
      while (loads.size > 1000) loads.delete(loads.keys().next().value!);
      const cleanup = () => { if (loads.get(loadKey)?.work === work) loads.delete(loadKey); };
      void work.then(cleanup, cleanup);
    }
    return work;
  };
  const refresh = (experimentId: string) => { if (cache.begin(key(experimentId), Date.now())) background(fetchPolicy(experimentId)); };
  const seal = async (context: LocalAssignmentContext) => {
    const payload = b64(encoder.encode(JSON.stringify({ version: 2, context })));
    const signature = b64(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(), encoder.encode(`eye/local/v2/${payload}`))));
    const token = `${payload}.${signature}`;
    invariant(token.length <= 16_384, 'invalid_input', 'Decision state exceeds 16 KiB');
    return token;
  };
  const persist = (experimentId: string, context: LocalAssignmentContext) => {
    contexts.set(experimentId, context);
    const work = (writes.get(experimentId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const token = await seal(context); tokens.set(experimentId, token);
      return token;
    });
    writes.set(experimentId, work);
    // Remote host persistence is ordered, but never gates the next local seal or state().
    const notification = (notifications.get(experimentId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const token = await work;
      await options?.onPrepared?.(experimentId, token);
    });
    notifications.set(experimentId, notification); background(notification);
  };
  const restore = async (experimentId: string) => {
    const pending = restored.get(experimentId);
    if (pending) return pending;
    if (contexts.has(experimentId)) return;
    const work = load(experimentId); restored.set(experimentId, work); return work;
  };
  const load = async (experimentId: string) => {
    const token = options?.tokens?.[experimentId];
    if (!token) return;
    try {
      invariant(token.length <= 16_384, 'invalid_input', 'Oversized state');
      const [payload, signature, extra] = token.split('.');
      invariant(payload && signature && !extra && await crypto.subtle.verify('HMAC', await signingKey(), unb64(signature), encoder.encode(`eye/local/v2/${payload}`)), 'invalid_input', 'Invalid state signature');
      const value = record(JSON.parse(new TextDecoder().decode(unb64(payload))), 'state');
      invariant(value.version === 2, 'invalid_input', 'Unsupported state version');
      const context = parseLocalContext(value.context);
      invariant(context.siteId === siteId && context.assignment.experimentId === experimentId, 'invalid_input', 'State scope mismatch');
      contexts.set(experimentId, context); tokens.set(experimentId, token);
    } catch (error) { report(error); }
  };
  const choose = (subject: Subject, experimentId: string, policy: PublishedPolicy | undefined): { decision: Decision; selection: LocalSelection } => {
    const previous = contexts.get(experimentId), now = Date.now();
    const selection = selectLocal({ siteId, experimentId, subject, now, newId: () => crypto.randomUUID(),
      ...(previous === undefined ? {} : { previous }), ...(policy === undefined ? {} : { policy: {
        ...policy, siteId, active: policy.status === 'active', freshUntil: (cache.checkedAt(key(experimentId)) ?? policy.publishedAt) + fresh, usableUntil: policy.publishedAt + maxAge,
        attributionWindowMs: policy.settings.attributionWindowMs ?? 7 * 86_400_000,
      } }) });
    if (selection.refreshPolicy) refresh(experimentId);
    const decision: Decision = selection.status === 'assigned' ? {
      status: 'assigned', assignment: selection.context.assignment, reason: selection.reason,
      localContext: selection.context, applyUntil: selection.applyUntil,
    } : { status: selection.status, experimentId };
    if (selection.status === 'assigned' && selection.context !== previous) persist(experimentId, selection.context);
    try { options?.onDecision?.({ experimentId, outcome: selection.status === 'unavailable' ? 'skipped' : selection.status,
      reason: !policy ? 'cold' : now >= policy.publishedAt + maxAge ? 'expired' : selection.status === 'no_active_arm' ? 'inactive' : selection.refreshPolicy ? 'stale' : 'fresh', authenticated: subject.uid !== undefined, at: now }); } catch (error) { report(error); }
    return { decision, selection };
  };
  const decide = async (subject: Subject, experimentId: string): Promise<Decision> => {
    if (!options) { refresh(experimentId); return { status: 'unavailable', experimentId }; }
    await restore(experimentId);
    return choose(subject, experimentId, cache.read(key(experimentId))).decision;
  };
  const prepare = async (subject: Subject, experimentId: string, context?: LocalAssignmentContext, forceRefresh = false): Promise<PreparedDecision & { token: string | null }> => {
    invariant(options, 'invalid_input', 'Configure decisions.secret');
    await restore(experimentId);
    const supplied = context === undefined ? undefined : parseLocalContext(context);
    if (supplied) contexts.set(experimentId, supplied);
    const cached = cache.read(key(experimentId)), now = Date.now();
    const policy = !forceRefresh && cached && cached.publishedAt <= now && now < cached.publishedAt + maxAge
      ? cached : await fetchPolicy(experimentId, forceRefresh);
    const result = choose(subject, experimentId, policy);
    // choose() persists new selections, but a supplied held context also needs
    // its own token: the restored token may be absent or describe an older sample.
    if (supplied && result.selection.status === 'assigned' && result.selection.context === supplied) {
      persist(experimentId, supplied);
    }
    await writes.get(experimentId);
    return { decision: result.decision, policy, token: result.decision.status === 'assigned' ? tokens.get(experimentId) ?? null : null,
      reuseUntil: result.selection.status === 'assigned' ? result.selection.applyUntil : Date.now() };
  };
  const stageExposure = (decision: Extract<Decision, { status: 'assigned' }>, occurredAt: number, eventId: string) => {
    invariant(decision.localContext && decision.applyUntil !== undefined, 'invalid_input', 'Expected a local decision from this SDK');
    const latest = contexts.get(decision.assignment.experimentId);
    const context = latest?.assignment.assignmentId === decision.assignment.assignmentId
      && (latest.sample?.startAt ?? 0) <= occurredAt
      && (!decision.localContext.sample || (latest.sample !== undefined
        && latest.sample.startAt > decision.localContext.sample.startAt)) ? latest : decision.localContext;
    const result = exposeLocal({ status: 'assigned', refreshPolicy: false, reason: decision.reason === 'selected' ? 'selected' : 'held', context, applyUntil: decision.applyUntil }, occurredAt, eventId);
    return { exposure: result.exposure, commit: () => {
      if (contexts.get(decision.assignment.experimentId) !== result.context) persist(decision.assignment.experimentId, result.context);
    } };
  };
  const expose = (...args: Parameters<typeof stageExposure>) => {
    const staged = stageExposure(...args); staged.commit(); return staged.exposure;
  };
  return { decide, prepare, expose, stageExposure, async state() {
    await Promise.all(Object.keys(options?.tokens ?? {}).map(restore));
    await Promise.all([...writes.values()]);
    return Object.fromEntries(tokens);
  } };
}

export function parseLocalContext(value: unknown): LocalAssignmentContext {
  const v = record(value, 'context'), assignment = parseAssignment(v.assignment);
  const context = { siteId: id(v.siteId, 'siteId'), subject: parseSubject(v.subject), assignment,
    drawIndex: timestamp(v.drawIndex, 'drawIndex'), attributionWindowMs: timestamp(v.attributionWindowMs, 'attributionWindowMs') };
  invariant(context.attributionWindowMs > 0 && context.attributionWindowMs <= 60 * 86_400_000, 'invalid_input', 'Invalid attribution horizon');
  if (v.sample === undefined) return context;
  const sample = record(v.sample, 'sample'), startAt = timestamp(sample.startAt, 'sample.startAt');
  invariant(startAt >= assignment.assignedAt, 'invalid_input', 'Sample predates assignment');
  return { ...context, sample: { sampleId: sampleId(sample.sampleId), startAt } };
}
