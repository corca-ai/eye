import { createEye, type EyeClient, type EyeOptions, type EventInput, type Submission } from './client.js';
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
export type { VariantDefinition } from './browser-types.js';
import type { VariantDefinition } from './browser-types.js';
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
  /** null이면 미참여다. fallback이 control 화면과 같아도 control 노출이 아니다. */
  armId: string | null;
  /** fallback에서는 null. assigned에서는 로컬 접수 결과이며 영속 저장 확인이 아니다. */
  expose(input?: ExposureInput): Submission | null;
}
/** 사용자 요청용 API. 관리·분석·명시적 준비·신원 전환에는 기존 createEye를 사용한다. */
export interface EyeRequest {
  /** 실제 노출 후 응답 쿠키 등에 저장할 실험별 토큰. 로컬 서명만 기다리며 서버 세션 저장 완료는 기다리지 않는다. */
  state(): Promise<Record<string, string>>;
  /** 로컬 검증 후 지원하는 arm 값을 반환한다. 원격 조회는 기다리지 않으며 오류·미준비·미지원 arm은 fallback이다. 호출마다 새 노출 핸들을 만든다. */
  variant<T>(definition: VariantDefinition<T>): Promise<VariantSelection<T>>;
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
    track: input => submit(client => client.track({ ...input, subject })),
    goal: input => submit(client => client.goal({ ...input, subject })),
    async variant<T>(definition: VariantDefinition<T>): Promise<VariantSelection<T>> {
      const fallback: VariantSelection<T> = { value: definition.fallback, armId: null, expose: () => null };
      if (!eye || options.experimentsEnabled === false) return fallback;
      try {
        const decision = await eye.decide({ subject, experimentId: definition.experimentId });
        if (decision.status !== 'assigned') return fallback;
        const armId = decision.assignment.armId;
        if (!Object.hasOwn(definition.variants, armId)) {
          report(new EyeError('invalid_input', `Unsupported arm for experiment ${definition.experimentId}: ${armId}`));
          return fallback;
        }
        let result: Submission | undefined;
        return {
          value: definition.variants[armId]!, armId,
          expose(input = {}) {
            if (result) return result;
            result = submit(client => client.expose({
              ...(userAttributes === undefined ? {} : { userAttributes }), ...input, subject, decision,
            }));
            return result;
          },
        };
      } catch (error) { report(error); return fallback; }
    },
  };
}
