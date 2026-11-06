import { createEye, type EyeClient, type EyeOptions, type EventInput, type Submission } from './client.js';
import { selectionFallback, selectionValue, isDataDefinition, withinBudget, type SelectionDefinition } from './variant-definition.js';
import { EyeError } from './core/errors.js';
import type { Attributes, GoalEvent, Subject, TrackEvent } from './core/types.js';

/** 요청마다 생성하며 신원은 생성 당시 값으로 고정한다. 로그인 전환 뒤에는 새 인스턴스를 만든다. */
export interface EyeRequestOptions extends EyeOptions {
  /** 서버 인증에서 확정한 신원. 이 인스턴스의 모든 수집·선택에 사용한다. */
  subject: Subject;
  /** 첫 실제 노출의 사용자군 속성. 개별 expose에서 덮어쓸 수 있다. */
  userAttributes?: Attributes;
  /** false면 실험 선택·준비·노출을 생략한다. track/goal 수집은 유지한다. 기본 true. */
  experimentsEnabled?: boolean;
}
export type { VariantDefinition, DataDefinition } from './browser-types.js';
import type { VariantDefinition, DataDefinition } from './browser-types.js';
/** 실제 표시 시점의 노출 정보. 생략한 ID·시각은 SDK가 생성한다. */
export interface ExposureInput {
  eventId?: string;
  occurredAt?: number;
  /** 첫 노출의 관측 사용자군. 요청 기본값을 이 노출에서 덮어쓴다. */
  userAttributes?: Attributes;
  /** 이 노출 사건에만 붙는 속성. arm 비교의 사용자군 필터와 별개다. */
  attributes?: Attributes;
}
/** 실제 적용한 뒤 expose를 호출한다. 한 핸들은 한 노출이며 재호출은 첫 결과(거절 포함)를 반환한다. */
export interface VariantSelection<T> {
  value: T;
  /** Abandon an un-applied selection for a counted performance default. Never retries business effects. */
  useDefault(reason: import('./core/types.js').DefaultReason): Promise<VariantSelection<T>>;
  /** null이면 미참여다. fallback이 control 화면과 같아도 control 노출이 아니다. */
  armId: string | null;
  /** fallback에서는 null. assigned에서는 로컬 접수 결과이며 영속 저장 확인이 아니다. */
  expose(input?: ExposureInput): Submission | null;
}
/** 사용자 요청용 API. 관리·분석·명시적 준비·신원 전환에는 기존 createEye를 사용한다. */
export interface EyeRequest {
  /** 실제 노출 후 응답 쿠키 등에 저장할 실험별 토큰. 로컬 서명만 기다리며 서버 세션 저장 완료는 기다리지 않는다. */
  state(): Promise<Record<string, string>>;
  /** Persist separately from policy tokens. */
  defaultState(): Promise<Record<string, string>>;
  /** 로컬 검증 후 지원하는 arm 값을 반환한다. 기본 maxWaitMs=0은 원격 조회를 기다리지 않고 양수이면 해당 예산만큼 준비를 기다린다.
   * 유효한 정책 또는 명시적 defaultArm 권한을 사용하며 오류·미지원 arm·권한 없는 미준비는 fallback이다. 호출마다 새 노출 핸들을 만든다. */
  variant<T>(definition: VariantDefinition<T>, options?: { maxWaitMs: number }): Promise<VariantSelection<T>>;
  /** Select remote data with a host-owned default and parser; no per-arm code mapping. */
  data<T>(definition: DataDefinition<T>, options?: { maxWaitMs: number }): Promise<VariantSelection<T>>;
  /** 신원을 다시 전달하지 않는다. 접수 거절과 비동기 전송 실패 모두 onError로 보고한다. */
  track(input: Omit<EventInput<TrackEvent>, 'subject'>): Submission;
  /** 사이트가 확정한 값. 재전송은 원래 eventId·occurredAt·subject·payload를 보존한다. */
  goal(input: Omit<EventInput<GoalEvent>, 'subject'>): Submission;
}

/** 공통 요청 경계에서 한 번 생성한다. SDK 초기화·선택 실패는 fallback, 수집 실패는 Submission으로 반환하며 onError에 보고한다. */
export function createEyeRequest(options: EyeRequestOptions): EyeRequest {
  const subject = { ...options.subject };
  const userAttributes = options.userAttributes === undefined ? undefined : { ...options.userAttributes };
  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* Host hook cannot break the request. */ } };
  let eye: EyeClient | undefined;
  let initializationError: unknown;
  try { eye = createEye({ ...options, onError: report }); }
  catch (error) { initializationError = error; report(error); }
  const submit = (call: (client: EyeClient) => Submission): Submission => {
    let result: Submission;
    try {
      if (!eye) throw initializationError;
      result = call(eye);
    } catch (error) {
      result = { accepted: false, error: { code: error instanceof EyeError ? error.code : 'unavailable', message: error instanceof Error ? error.message : 'Eye request unavailable' } };
    }
    if (!result.accepted) {
      // Optional-call arguments are evaluated only when a reporter exists.
      try { options.onError?.(new EyeError(result.error.code, result.error.message)); } catch { /* host hook */ }
    }
    return result;
  };
  return {
    state: async () => eye ? eye.state() : {},
    defaultState: async () => eye ? eye.defaultState() : {},
    track: input => submit(client => client.track({ ...input, subject })),
    goal: input => submit(client => client.goal({ ...input, subject })),
    variant: (definition, wait) => select(definition, wait),
    data: (definition, wait) => select(definition, wait),
  };
  async function select<T>(definition: SelectionDefinition<T>, wait: { maxWaitMs: number } = { maxWaitMs: 0 }): Promise<VariantSelection<T>> {
    const fallback = selectionFallback(definition);
    if (!Number.isSafeInteger(wait.maxWaitMs) || wait.maxWaitMs < 0) throw new EyeError('invalid_input', 'Invalid wait budget');
    let applied = false;
    let owner = 0;
    let replacement: Promise<VariantSelection<T>> | undefined;
    let replaced = false;
    const make = (decision?: import('./transport.js').AssignedDecision, reason?: import('./core/types.js').DefaultReason, resolved?: { value: T }): VariantSelection<T> => {
      const handleOwner = owner;
      let result: Submission | undefined;
      return { value: resolved === undefined ? fallback : resolved.value,
        armId: decision?.assignment.armId ?? null,
        useDefault(defaultReason) {
          if (applied) return Promise.reject(new EyeError('conflict', 'An applied occurrence cannot switch arms'));
          replacement ??= (async () => {
            replaced = true; owner++;
            if (!decision || !eye || options.experimentsEnabled === false || definition.defaultArm === undefined) return make();
            try {
              const next = await eye.decideDefault({ subject, experimentId: definition.experimentId, defaultArm: definition.defaultArm });
              return make(next.status === 'assigned' ? next : undefined, defaultReason);
            } catch (error) { report(error); return make(); }
          })();
          return replacement;
        },
        expose(input = {}) {
          if (result) return result;
          if (!decision) { applied = true; return null; }
          // A replacement locks the original handle, not its replacement.
          if (replaced && handleOwner !== owner)
            return { accepted: false, error: { code: 'conflict', message: 'Occurrence was replaced' } };
          if (applied) return { accepted: false, error: { code: 'conflict', message: 'Occurrence already applied' } };
          applied = true; // Application has happened even if collection is rejected.
          result = submit(client => client.expose({ ...(userAttributes === undefined ? {} : { userAttributes }),
            ...input, ...(reason === undefined ? {} : { defaultReason: reason }), subject, decision }));
          return result;
        } };
    };
    if (!eye || options.experimentsEnabled === false) return make();
    try {
      let decision = await eye.decide({ subject, experimentId: definition.experimentId });
      if (decision.status === 'unavailable' && wait.maxWaitMs > 0) {
        try {
          const prepared = await withinBudget(eye.prepare({ subject, experimentId: definition.experimentId }), wait.maxWaitMs);
          if (prepared) decision = prepared.decision;
        } catch (error) { report(error); }
      }
      if (decision.status === 'assigned') {
        const value = selectionValue(definition, decision.assignment.armId, decision.data);
        if (value.supported) return make(decision, undefined, value);
        report(new EyeError('invalid_input', `Unsupported arm or invalid data for experiment ${definition.experimentId}: ${decision.assignment.armId}`));
        if (isDataDefinition(definition)) {
          const next = await eye.decideDefault({ subject, experimentId: definition.experimentId, defaultArm: definition.defaultArm });
          return make(next.status === 'assigned' ? next : undefined, 'invalid_data');
        }
        return make();
      }
      if (decision.status === 'unavailable' && definition.defaultArm !== undefined) {
        const next = await eye.decideDefault({ subject, experimentId: definition.experimentId, defaultArm: definition.defaultArm });
        if (next.status === 'assigned') return make(next, wait.maxWaitMs > 0 ? 'deadline' : 'unprepared');
      }
      return make();
    } catch (error) { report(error); return make(); }
  }
}
