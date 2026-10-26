import { DEFAULT_POLICY_MAX_AGE_MS, policyFreshMs } from './policy-timing.js';
import { createEye, type EyeOptions } from './client.js';
import { parseAssignment } from './core/events.js';
import { parseLocalContext } from './decisions.js';
import type { LocalAssignmentContext } from './core/local-assignment.js';
import { attributes, id, record, subject as parseSubject, timestamp } from './core/validation.js';
import { invariant } from './core/errors.js';
import { collectionLimits } from './collection-limits.js';
import type { Attributes, Subject } from './core/types.js';
import type { AssignedDecision } from './transport.js';
import type { BrowserSnapshot, BrowserEventResult } from './browser-types.js';

/** 인증된 서버 요청마다 구성한다. prepare에는 decisions.secret도 필요하다. */
export interface BrowserServerOptions extends EyeOptions {
  /** 호스트 인증에서 확정한다. 브라우저가 보낸 subject를 그대로 신뢰하지 않는다. */
  subject: Subject;
  /** Host-authenticated browser binding, stable across login/logout, never taken from request JSON. */
  browserBinding: string;
  /** 브라우저와 공유하는 비밀이 아닌 인증 세대. 로그인·로그아웃·계정 변경마다 바꾼다. */
  scope: string;
  /** Secret of at least 32 UTF-8 bytes; kept on server. Domain-separated from decision signing. */
  receiptSecret: string;
  /** 증표에 고정할 사용자군 속성. 첫 실제 노출의 관측 속성으로 사용한다. */
  userAttributes?: Attributes;
}
const encoder = new TextEncoder();
const grace = 300_000;
function encode(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function decode(text: string) { return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }

/** 요청별 브라우저 준비·노출 어댑터. 호스트가 인증·동일 Origin POST·허용 실험·본문 크기를 확인한 뒤 호출한다. */
export function createEyeBrowserServer(options: BrowserServerOptions) {
  const eye = createEye(options), subject = parseSubject(options.subject);
  const userAttributes = attributes(options.userAttributes ?? {}, collectionLimits(options.collectionLimits));
  const binding = id(options.browserBinding, 'browserBinding'), scope = id(options.scope, 'scope');
  let installation: Promise<string> | undefined;
  const installationId = () => installation ??= options.service.getInstallationId();
  const audience = (id: string) => encoder.encode(`eye/browser-exposure/v1/${id}`);
  let importedKey: Promise<CryptoKey> | undefined;
  const importKey = async () => {
    invariant(encoder.encode(options.receiptSecret).length >= 32, 'invalid_input', 'receiptSecret requires 32 bytes');
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`eye/browser-exposure/v1/${options.receiptSecret}`));
    return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
  };
  const key = () => importedKey ??= importKey();
  const seal = async (value: unknown, installation: string) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: audience(installation) }, await key(), encoder.encode(JSON.stringify(value)));
    return `${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
  };
  const openReceipt = async (receipt: unknown) => {
    invariant(typeof receipt === 'string' && receipt.length <= 24_000, 'invalid_input', 'Invalid receipt');
    const parts = receipt.split('.'); invariant(parts.length === 2, 'invalid_input', 'Invalid receipt');
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(parts[0]!), additionalData: audience(await installationId()) }, await key(), decode(parts[1]!));
    const value = record(JSON.parse(new TextDecoder().decode(clear)), 'receipt');
    invariant(value.binding === binding, 'invalid_input', 'Receipt browser mismatch');
    return value;
  };
  const withSample = (context: LocalAssignmentContext, sample: unknown) => sample === undefined ? context : parseLocalContext({ ...context, sample });
  return {
    /** 최대 20실험을 준비한다. 필요하면 정책 조회를 기다리며 실패·비활성 실험은 choices에서 제외한다.
     * previous는 실험별 BrowserState이며 검증 후 재사용한다. 실험별 실패는 onError로 보고한다. 잘못된 배치 입력은 reject한다. */
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
            userAttributes }, prepared.policy.installationId);
          invariant(receipt.length <= 24_000, 'invalid_input', 'Exposure receipt exceeds 24 KB');
          choices.push({ experimentId, armId: prepared.decision.assignment.armId, applyUntil, receipt,
            refreshAfter: Math.min(applyUntil, issuedAt + policyFreshMs(options.decisions)),
            assignmentId: prepared.decision.assignment.assignmentId, observationWindowMs: prepared.decision.assignment.settings.observationWindowMs,
            ...(prepared.decision.localContext?.sample === undefined ? {} : { sample: prepared.decision.localContext.sample }) });
        } catch (error) { try { options.onError?.(error); } catch { /* host hook */ } }
      }
      return { scope, serverNow: Date.now(), choices };
    },
    /** 최대 50노출·48KB를 검증하고 Queue 접수를 기다린다. 같은 browserBinding이면 인증 전환 전 증표의 원래 신원을 보존한다.
     * 사건별 거절은 accepted:false, 배치 오류·일시적 미래 시각·Queue 실패는 reject한다. 재시도는 원래 payload를 유지한다. */
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
