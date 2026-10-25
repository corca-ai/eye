/** 서버가 준비한 arm과 불투명한 노출 증표. 브라우저는 receipt를 해석·수정하지 않는다. */
export interface BrowserChoice {
  experimentId: string; armId: string; receipt: string;
  /** 새 view에서 이 시각 이후 백그라운드 재준비한다. 기존 view를 교체하지 않는다. */
  refreshAfter?: number;
  /** 이 시각 전까지만 새 노출에 적용할 수 있다(서버 Unix ms). */
  applyUntil: number;
  /** 동일 배정의 반복 노출을 같은 관측으로 묶는 SDK 문맥. 호스트가 직접 만들지 않는다. */
  assignmentId?: string; observationWindowMs?: number; sample?: BrowserSample;
}
/** 현재 인증 scope의 준비 결과. serverNow는 브라우저 시각 추정에 쓰는 서버 Unix ms다. */
export interface BrowserSnapshot { scope: string; serverNow: number; choices: BrowserChoice[] }
/** 최초 실제 노출에서 고정하는 관측 ID와 시작 시각(Unix ms). SDK가 유지한다. */
export interface BrowserSample { sampleId: string; startAt: number }
/** 다음 준비 요청에 되돌려 보내는 증표와 관측 문맥. 서버에서 검증한다. */
export interface BrowserState { receipt: string; sample?: BrowserSample }
/** 서버 수신 경로로 보내는 실제 노출. 재시도 시 ID·시각·증표·표본을 그대로 보낸다. */
export interface BrowserExposure { eventId: string; receipt: string; occurredAt: number; sample?: BrowserSample }
/** 서버 receive의 사건별 결과. true는 Queue 접수, false는 재시도하지 않을 거절이며 분석 반영 확인은 아니다. */
export interface BrowserEventResult { eventId: string; accepted: boolean }

/** 서비스가 지원하는 arm → 화면 값. fallback은 배정과 별개의 미참여 값이다. */
export interface VariantDefinition<T> {
  experimentId: string;
  variants: Readonly<Record<string, T>>;
  fallback: T;
}
