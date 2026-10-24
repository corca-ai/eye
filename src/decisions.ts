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
  /** 기본 60000ms, 양의 정수. 이후에는 오래된 정책을 재사용하면서 갱신한다. */
  freshMs?: number;
  /** 기본 300000ms, freshMs 이상 정수. 발행 시각부터 이 나이를 넘으면 미참여한다. */
  maxAgeMs?: number;
  /** 로컬 결정마다 동기 호출. 미참여율 측정용이며 느린 I/O를 여기서 기다리지 않는다. */
  onDecision?: (metric: DecisionMetric) => void;
  /** 로컬 배정 또는 실제 노출로 상태가 바뀌면 서명 후 호출한다. 다음 요청이 읽을 서버 세션에 저장한다. 쿠키는 state()를 기다린 뒤 응답에 쓴다. */
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
type DecisionService = Pick<EyeService, 'getPublishedPolicy'>;
const caches = new WeakMap<DecisionService, DecisionCache>();
const encoder = new TextEncoder();
function b64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function unb64(text: string): Uint8Array { return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
export function decisionRuntime(service: DecisionService, ctx: Pick<ExecutionContext, 'waitUntil'>, siteId: string, options: DecisionOptions | undefined, report: (error: unknown) => void) {
  let shared = caches.get(service);
  if (!shared) { shared = new DecisionCache(); caches.set(service, shared); }
  const cache = options?.cache ?? shared;
  const fresh = options?.freshMs ?? 60_000, maxAge = options?.maxAgeMs ?? 300_000;
  invariant(fresh > 0 && Number.isSafeInteger(fresh) && Number.isSafeInteger(maxAge) && maxAge >= fresh, 'invalid_input', 'Invalid policy freshness settings');
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
  const fetchPolicy = async (experimentId: string) => { const policy = await service.getPublishedPolicy(siteId, experimentId); cache.put(key(experimentId), policy); return policy; };
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
        ...policy, siteId, active: policy.status === 'active', freshUntil: policy.publishedAt + fresh, usableUntil: policy.publishedAt + maxAge,
        attributionWindowMs: policy.settings.attributionWindowMs ?? 7 * 86_400_000,
      } }) });
    if (selection.refreshPolicy) refresh(experimentId);
    const decision: Decision = selection.status === 'assigned' ? {
      status: 'assigned', assignment: selection.context.assignment, reason: selection.reason,
      localContext: selection.context, applyUntil: selection.applyUntil,
    } : { status: selection.status, experimentId };
    if (selection.status === 'assigned' && selection.context !== previous) persist(experimentId, selection.context);
    try { options?.onDecision?.({ experimentId, outcome: selection.status === 'unavailable' ? 'skipped' : selection.status,
      reason: !policy ? 'cold' : selection.refreshPolicy ? 'stale' : 'fresh', authenticated: subject.uid !== undefined, at: now }); } catch (error) { report(error); }
    return { decision, selection };
  };
  const decide = async (subject: Subject, experimentId: string): Promise<Decision> => {
    if (!options) { refresh(experimentId); return { status: 'unavailable', experimentId }; }
    await restore(experimentId);
    return choose(subject, experimentId, cache.read(key(experimentId))).decision;
  };
  const prepare = async (subject: Subject, experimentId: string, context?: LocalAssignmentContext): Promise<PreparedDecision & { token: string | null }> => {
    invariant(options, 'invalid_input', 'Configure decisions.secret');
    await restore(experimentId);
    if (context) contexts.set(experimentId, parseLocalContext(context));
    const policy = await fetchPolicy(experimentId), result = choose(subject, experimentId, policy);
    await writes.get(experimentId);
    return { decision: result.decision, policy, token: result.decision.status === 'assigned' ? tokens.get(experimentId) ?? null : null,
      reuseUntil: result.selection.status === 'assigned' ? result.selection.applyUntil : Date.now() };
  };
  const expose = (decision: Extract<Decision, { status: 'assigned' }>, occurredAt: number, eventId: string) => {
    invariant(decision.localContext && decision.applyUntil !== undefined, 'invalid_input', 'Expected a local decision from this SDK');
    const latest = contexts.get(decision.assignment.experimentId);
    const context = latest?.assignment.assignmentId === decision.assignment.assignmentId
      && (latest.sample?.startAt ?? 0) <= occurredAt
      && (!decision.localContext.sample || (latest.sample !== undefined
        && latest.sample.startAt > decision.localContext.sample.startAt)) ? latest : decision.localContext;
    const result = exposeLocal({ status: 'assigned', refreshPolicy: false, reason: decision.reason === 'selected' ? 'selected' : 'held', context, applyUntil: decision.applyUntil }, occurredAt, eventId);
    persist(decision.assignment.experimentId, result.context);
    return result.exposure;
  };
  return { decide, prepare, expose, async state() { await Promise.all([...writes.values()]); return Object.fromEntries(tokens); } };
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
