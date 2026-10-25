import { invariant } from './core/errors.js';

/** 서버 SDK 인스턴스별 수집 예산. 모든 값은 양의 안전한 정수이며 collectionLimits에서 부분 지정한다. */
export interface CollectionLimits {
  /** 기본 1000. 인스턴스 수명 동안 접수할 최대 사건 수. flush 후에도 복구되지 않는다. */
  maxEvents: number;
  /** 기본 1000000. 접수 사건의 UTF-8 JSON 크기 + 건당 여유 200바이트의 누적 상한. */
  maxBytes: number;
  /** 기본 480000. 전송 대기·진행 중 사건의 같은 추정 바이트 상한. 성공·실패로 전송 시도가 끝나면 복구된다. */
  maxPendingBytes: number;
  /** 기본 256. 사건의 attributes와 userAttributes 각각에 허용할 최상위 키 수. */
  maxAttributeKeys: number;
  /** 기본 100000. 각 속성 문자열의 UTF-16 길이 상한. 기존 사건당 100KB 제한도 별도로 적용한다. */
  maxAttributeStringLength: number;
}
const defaults: Readonly<CollectionLimits> = Object.freeze({ maxEvents: 1000, maxBytes: 1_000_000,
  maxPendingBytes: 480_000, maxAttributeKeys: 256, maxAttributeStringLength: 100_000 });

export function collectionLimits(input: Partial<CollectionLimits> | undefined): Readonly<CollectionLimits> {
  if (input === undefined) return defaults;
  invariant(typeof input === 'object' && input !== null && !Array.isArray(input), 'invalid_input', 'Invalid collectionLimits');
  const result = { ...defaults };
  for (const key of Object.keys(input)) {
    invariant(Object.hasOwn(defaults, key), 'invalid_input', `Unknown collection limit: ${key}`);
    const value = input[key as keyof CollectionLimits];
    invariant(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, 'invalid_input', `${key} must be a positive safe integer`);
    result[key as keyof CollectionLimits] = value;
  }
  return result;
}
