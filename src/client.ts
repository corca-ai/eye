import { decisionRuntime, type DecisionOptions } from './decisions.js';
import { EyeError, invariant } from './core/errors.js';
import type { ErrorCode } from './core/errors.js';
import { parseCreateExperiment, parseEnvelope } from './core/events.js';
import { id, record, RETENTION_MS, subject as parseSubject } from './core/validation.js';
import type { Attributes, CreateExperiment, EventEnvelope, ExperimentSettings, GoalEvent, IdentityEvent, Subject, TrackEvent } from './core/types.js';
import type { AssignedDecision, EyeService } from './transport.js';
import type { AnalyticsAPI } from './analytics/types.js';

export const MAX_EVENT_BYTES = 100_000;
export const MAX_BATCH_BYTES = 240_000;
const encoder = new TextEncoder();
/** eventId 기본 UUID, occurredAt 기본 현재 시각. attributes는 선택적 사건 속성이다. */
export type EventInput<T> = Omit<T, 'kind' | 'eventId' | 'occurredAt'> & { eventId?: string; occurredAt?: number };
/** accepted는 로컬 검증 성공이지 영속 저장 확인이 아니다. 실패는 error.code와 message로 반환된다. */
export type Submission = { accepted: true; eventId: string } | { accepted: false; error: { code: ErrorCode; message: string } };
export interface EyeOptions {
  /** 빠른 배정의 서명·세션·정책 캐시 설정. 생략하면 decide는 배정을 준비하거나 재사용할 수 없다. */
  decisions?: DecisionOptions;
  /** 호스트 Wrangler의 Eye Worker Service Binding. */
  service: EyeService;
  /** 현재 요청의 실행 컨텍스트. 수집과 배정 준비를 waitUntil에 등록한다. */
  ctx: Pick<ExecutionContext, 'waitUntil'>;
  /** 사이트별 격리 키. 같은 사이트의 수집·관리·조회에서 동일하게 사용한다. */
  siteId: string;
  /** Reports background delivery failures. Exceptions from this hook never fail host requests. */
  onError?: (error: unknown) => void;
}
export function encodedSize(value: unknown): number { return encoder.encode(JSON.stringify(value)).byteLength; }

/** 요청마다 생성한다. 관리·조회만 필요하면 decisions 설정을 생략할 수 있다. */
export function createEye(options: EyeOptions) {
  const siteId = id(options.siteId, 'siteId'), service = options.service;
  let pending: { envelope: EventEnvelope; bytes: number }[] = [];
  let delivery: Promise<void> | null = null;
  const report = (error: unknown) => {
    try { options.onError?.(error); } catch { /* The host's error hook cannot break event delivery. */ }
  };
  const flush = (): Promise<void> => {
    if (delivery) return delivery;
    if (pending.length === 0) return Promise.resolve();
    delivery = Promise.resolve().then(async () => {
      let failed = false;
      let failure: unknown;
      while (pending.length > 0) {
        const queued = pending;
        pending = [];
        let cursor = 0;
        while (cursor < queued.length) {
          const batch: EventEnvelope[] = [];
          let bytes = 0;
          while (queued[cursor] && batch.length < 100 && bytes + queued[cursor]!.bytes <= MAX_BATCH_BYTES) {
            const next = queued[cursor++]!; batch.push(next.envelope); bytes += next.bytes;
          }
          try { await service.ingest(batch); } catch (error) { failed = true; failure = error; }
        }
      }
      if (failed) throw failure;
    }).finally(() => { delivery = null; if (pending.length > 0) void flush(); });
    // Attach the rejection handler immediately, even when the caller never awaits flush().
    options.ctx.waitUntil(delivery.catch(report));
    return delivery;
  };
  const submit = (build: () => object): Submission => {
    try {
      const event = build();
      const receivedAt = Date.now();
      const envelope = parseEnvelope({ siteId, receivedAt, event }, receivedAt);
      const bytes = encodedSize(envelope) + 200;
      invariant(bytes <= MAX_EVENT_BYTES, 'invalid_input', 'Event exceeds the 100 KB encoded envelope limit');
      pending.push({ envelope, bytes });
      void flush();
      return { accepted: true, eventId: envelope.event.eventId };
    } catch (error) {
      return { accepted: false, error: { code: error instanceof EyeError ? error.code : 'invalid_input', message: error instanceof Error ? error.message : 'Invalid event' } };
    }
  };
  const base = <T extends { eventId?: string; occurredAt?: number }>(input: T) => ({ ...input, eventId: input.eventId ?? crypto.randomUUID(), occurredAt: input.occurredAt ?? Date.now() });
  const decisions = decisionRuntime(service, options.ctx, siteId, options.decisions, report);
  return {
    /** 중앙 신원·배정을 기다려 서명 토큰을 만든다. decisions.secret 필요. 반환 token은 미배정이면 null이며 호출자가 저장한다. 명시적 prepare는 onPrepared를 호출하지 않는다. */
    prepare: (input: { subject: Subject; experimentId: string }) => decisions.prepare(parseSubject(input.subject), id(input.experimentId, 'experimentId')),
    /** 일반 사건을 분석에 기록한다. name은 서비스가 정의한다. goal 학습을 직접 발생시키지 않는다. */
    track: (input: EventInput<TrackEvent>): Submission => submit(() => ({ ...base(input), kind: 'track' })),
    /** 사이트가 확정한 골을 전달한다. goalId는 먼저 등록한다. value는 모든 골에서 같은 단위의 유한한 값이며 음수·0도 허용한다. */
    goal: (input: EventInput<GoalEvent>): Submission => submit(() => ({ ...base(input), kind: 'goal' })),
    /** arm을 실제 적용한 뒤 assigned decision을 그대로 전달한다. userAttributes는 첫 노출 때 관측 속성으로 고정하고, attributes는 개별 노출 사건 속성으로 보관한다. */
    expose: (input: { subject: Subject; decision: AssignedDecision; eventId?: string; occurredAt?: number; userAttributes?: Attributes; attributes?: Attributes }): Submission => submit(() => {
      const { decision, ...rest } = input;
      return { ...base(rest), kind: 'exposure', assignment: decision.assignment, ...(decision.routingKey === undefined ? {} : { routingKey: decision.routingKey }) };
    }),
    /** 로그인 시 cid와 인증된 uid를 함께 전달한다. 기존 uid 배정을 우선하고 없는 실험의 cid 상태는 인계한다. 호스트의 이전 배정 토큰도 비운다. */
    identify: (input: EventInput<IdentityEvent> & { subject: Subject & { uid: string } }): Submission => submit(() => ({ ...base(input), kind: 'identify' })),
    /** 로그아웃 시 uid 없이 현재 cid를 전달한다. 새 익명 구간을 시작한다. 호스트의 이전 배정 토큰도 비운다. */
    logout: (input: EventInput<IdentityEvent>): Submission => submit(() => ({ ...base(input), kind: 'logout' })),
    /** 원격 응답을 기다리지 않고 준비된 배정을 재사용한다. unavailable이면 기본 화면을 사용하고 노출을 기록하지 않는다. 세션 준비와 최신성은 빠른 배정 가이드를 따른다. */
    decide: (input: { subject: Subject; experimentId: string }) => decisions.decide(parseSubject(input.subject), id(input.experimentId, 'experimentId')),
    /** 중앙 배정을 기다리는 경로. decisions 설정은 불필요하나 사용자 요청에 RPC 지연이 추가된다. */
    decideConsistent: (input: { subject: Subject; experimentId: string }) => service.decide(siteId, parseSubject(input.subject), id(input.experimentId, 'experimentId')),
    /** Optional for jobs/tests that need to await Queue ingestion. Normal request handlers need not await this. */
    flush,
    analytics: {
      /** 기간에 걸친 UTC 날짜 전체의 속성 키·타입·출처 목록. coverage로 실제 조회 범위를 확인한다. */
      attributeKeys: query => service.analyticsAttributeKeys(siteId, query),
      /** 발행된 arm 선택 확률·평균·점수 이력. 모든 중앙 선택 순간의 기록은 아니다. */
      policies: query => service.analyticsPolicies(siteId, query),
      /** bucket·arm·세대별 신규 배정 수와 실제 노출 수 및 각각의 비율. */
      traffic: query => service.analyticsTraffic(siteId, query),
      /** 관측 시작 시각의 bucket별 arm 성과. arms와 동일한 분모·속성 필터를 사용한다. */
      armSeries: query => service.analyticsArmSeries(siteId, query),
      /** 관측 시작 시각 기준 arm·세대별 완료 보상 비교. groupBy/filter는 최초 노출의 userAttributes를 사용한다. */
      arms: query => service.analyticsArms(siteId, query),
      /** 한 cid 또는 uid의 사건·배정·관측·귀속·신원 연결 이력. nextCursor로 다음 페이지를 조회한다. */
      timeline: query => service.analyticsTimeline(siteId, query),
      /** 발생 시각 기준 accepted 원본 goal의 수와 가치 합. filter는 사건 attributes에 적용한다. */
      goals: query => service.analyticsGoals(siteId, query),
      /** goal 합계를 UTC bucket별로 반환한다. 사건 없는 bucket은 행을 만들지 않는다. */
      series: query => service.analyticsSeries(siteId, query),
      /** 원본 사건 attributes의 지정 키 값별 빈도. 관측 userAttributes의 분포와는 다르다. */
      attributeValues: query => service.analyticsAttributeValues(siteId, query),
    } satisfies AnalyticsAPI,
    /** 신뢰할 수 있는 관리 경로에서 사용한다. */
    experiments: {
      /** 최초 정의를 등록한다. 같은 최초 정의로 재호출하면 현재 정의를 반환하며, 다른 최초 정의는 conflict다. */
      create: (input: CreateExperiment) => {
        const raw = record(input, 'experiment'), rawSettings = record(raw.settings, 'settings');
        // Only the Experiment DO knows whether this is a new or legacy definition.
        // Validate without turning an omitted deadline into an explicit new default.
        const omitted = rawSettings.correctionWindowMs === undefined;
        const parsed = parseCreateExperiment(omitted
          ? { ...raw, settings: { ...rawSettings, correctionWindowMs: RETENTION_MS } } : input);
        const { correctionWindowMs: _deadline, ...withoutDeadline } = parsed.settings;
        return service.createExperiment(siteId, omitted ? { ...parsed, settings: withoutDeadline } : parsed);
      },
      /** 현재 실험 정의를 반환한다. 없으면 not_found 오류. */
      get: (experimentId: string) => service.getExperiment(siteId, id(experimentId, 'experimentId')),
/** ID 오름차순 목록. after는 제외할 마지막 ID, limit 기본 100·최대 1000. 삭제된 실험도 포함한다. */
      list: (options: { after?: string; limit?: number } = {}) => service.listExperiments(siteId, options.after, options.limit),
      /** 설정 patch를 반영하고 변경 시 새 학습 세대를 시작한다. 기존 배정의 설정·최소 유지 기간은 보존한다. */
      update: (experimentId: string, input: Partial<ExperimentSettings>) => service.updateExperiment(siteId, id(experimentId, 'experimentId'), input),
      /** 활성 arm을 추가한다. 기존 arm은 그대로 반환하며 삭제된 ID는 재사용할 수 없다. */
      addArm: (experimentId: string, armId: string) => service.addArm(siteId, id(experimentId, 'experimentId'), id(armId, 'armId')),
      /** arm을 일시중지한다. 중앙에서는 최소 유지 기간보다 우선하며 로컬 정책에는 갱신 지연이 있다. */
      pauseArm: (experimentId: string, armId: string) => service.setArmStatus(siteId, id(experimentId, 'experimentId'), id(armId, 'armId'), 'paused'),
      /** 일시중지한 arm을 재개한다. 삭제된 arm은 재개할 수 없다. */
      resumeArm: (experimentId: string, armId: string) => service.setArmStatus(siteId, id(experimentId, 'experimentId'), id(armId, 'armId'), 'active'),
      /** 실험 전체를 일시중지한다. 기존 이력과 보상은 유지한다. */
      pause: (experimentId: string) => service.setExperimentStatus(siteId, id(experimentId, 'experimentId'), 'paused'),
      /** 실험 전체를 재개한다. 개별 arm의 중지 상태는 유지한다. */
      resume: (experimentId: string) => service.setExperimentStatus(siteId, id(experimentId, 'experimentId'), 'active'),
      /** 실험을 영구 비활성화한다. 이력은 보존하고 ID 재사용·재개를 금지한다. */
      delete: (experimentId: string) => service.setExperimentStatus(siteId, id(experimentId, 'experimentId'), 'deleted'),
      /** arm을 영구 비활성화한다. 과거 노출의 지연 보상은 귀속 규칙을 따르며 ID를 재사용하지 않는다. */
      deleteArm: (experimentId: string, armId: string) => service.setArmStatus(siteId, id(experimentId, 'experimentId'), id(armId, 'armId'), 'deleted'),
      /** 중앙의 현재 감쇠 정책. 사용자별 held 배정 확률이나 최신 수집 완료를 뜻하지 않는다. */
      policy: (experimentId: string) => service.getPolicy(siteId, id(experimentId, 'experimentId')),
    },
    goals: {
      /** ID만 등록한다. 가치·달성 조건은 서비스가 goal 호출마다 제공한다. 기존 ID는 현재 정의 반환, 삭제 ID 재사용은 거절한다. */
      create: (goalId: string) => service.createGoal(siteId, id(goalId, 'goalId')),
      /** 없으면 null. 실험 get은 없으면 not_found 오류라는 차이가 있다. */
      get: (goalId: string) => service.getGoal(siteId, id(goalId, 'goalId')),
/** goalId 오름차순 정의 목록. after는 제외할 마지막 ID, limit 기본 100·최대 1000. 삭제된 골도 포함한다. */
      list: (options: { after?: string; limit?: number } = {}) => service.listGoals(siteId, options.after, options.limit),
      /** 일시중지 이후 발생한 골을 무시한다. 늦게 도착한 사건은 발생 당시 상태로 판단한다. */
      pause: (goalId: string) => service.setGoalStatus(siteId, id(goalId, 'goalId'), 'paused'),
      /** 일시중지한 골을 재개한다. 재개 이후 발생한 사건을 수집한다. */
      resume: (goalId: string) => service.setGoalStatus(siteId, id(goalId, 'goalId'), 'active'),
      /** 골을 영구 비활성화한다. 기존 기록·보상을 유지하고 ID 재사용을 금지한다. */
      delete: (goalId: string) => service.setGoalStatus(siteId, id(goalId, 'goalId'), 'deleted'),
    },
  };
}
export type EyeClient = ReturnType<typeof createEye>;
