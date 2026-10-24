/** Wire format shared by the browser and host Worker; receipts are opaque. */
export interface BrowserChoice {
  experimentId: string; armId: string; receipt: string;
  /** 새 view에서 이 시각 이후 백그라운드 재준비한다. 기존 view를 교체하지 않는다. */
  refreshAfter?: number;
  applyUntil: number; assignmentId?: string; observationWindowMs?: number; sample?: BrowserSample;
}
export interface BrowserSnapshot { scope: string; serverNow: number; choices: BrowserChoice[] }
export interface BrowserSample { sampleId: string; startAt: number }
export interface BrowserState { receipt: string; sample?: BrowserSample }
export interface BrowserExposure { eventId: string; receipt: string; occurredAt: number; sample?: BrowserSample }
export interface BrowserEventResult { eventId: string; accepted: boolean }

/** 서비스가 지원하는 arm → 화면 값. fallback은 배정과 별개의 미참여 값이다. */
export interface VariantDefinition<T> {
  experimentId: string;
  variants: Readonly<Record<string, T>>;
  fallback: T;
}
