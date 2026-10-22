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
