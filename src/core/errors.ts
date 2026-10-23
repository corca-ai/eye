/** invalid_input: 입력·조회 제약 위반; not_found: 대상 없음; conflict: 기존 정의·삭제 상태 충돌; deleted: 삭제된 골; outside_retention: 60일 범위 밖 사건; numeric_range: 유한 수 범위 초과; unavailable: 일시적 처리·조회 불가. */
export type ErrorCode =
  | 'invalid_input' | 'not_found' | 'conflict' | 'deleted'
  | 'outside_retention' | 'numeric_range' | 'unavailable';

/** Stable codes are part of the public API; message text is diagnostic only. */
export class EyeError extends Error {
  override readonly name = 'EyeError';
  constructor(readonly code: ErrorCode, message: string) { super(message); }
}

export function invariant(condition: unknown, code: ErrorCode, message: string): asserts condition {
  if (!condition) throw new EyeError(code, message);
}

export function finite(value: number, label: string): number {
  invariant(Number.isFinite(value), 'numeric_range', `${label} is outside the finite numeric range`);
  return value;
}
