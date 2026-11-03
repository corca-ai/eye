# 서비스 기본값과 데이터 arm

코드 실험과 데이터 실험 모두 기본 구현·데이터는 서비스가 소유한다.
Eye는 기본 arm의 ID와 학습을 관리하며 기본 문구·컴포넌트를 저장하지 않는다.
다른 arm에는 불변 JSON을 붙일 수 있다. 공통 렌더러를 한 번 배포한 뒤에는
그 형식 안에서 arm을 추가·정지·삭제하는 데 서비스 재배포가 필요하지 않다.

## 정의와 변경

기존 문자열 ID와 `{ armId, data? }`를 함께 지원한다. 기본 arm에는 데이터를
넣지 않는다. default 여부는 기존처럼 호스트의 `defaultArm` 설정으로 정한다.

```ts
await eye.experiments.create({
  experimentId: 'landing-copy',
  arms: ['control', { armId: 'copy-b', data: { headline: 'Write together', ctaLabel: 'Start' } }],
  settings: { minHoldMs: 0 },
});
await eye.experiments.addArm('landing-copy', {
  armId: 'copy-c', data: { headline: 'Focus on your paper', ctaLabel: 'Try now' },
});
await eye.experiments.pauseArm('landing-copy', 'copy-b');
```

같은 ID에 다른 데이터를 넣으면 conflict다. 같은 데이터의 재요청은 멱등이고,
기존 ID만 넘기는 addArm은 데이터를 바꾸지 않는다. 문구 수정은 새 ID로 추가한다.
기본 구현·데이터를 바꿀 때도 새 default arm ID를 등록하고 서비스 설정을 바꾼다.
삭제 ID를 재사용하거나 일시정지로 학습을 초기화하지 않는다.

JSON은 null·boolean·유한한 숫자·문자열·배열·일반 객체만 허용한다. arm당 UTF-8
16 KiB, 실험 전체 데이터 64 KiB, 중첩 16단계와 4096개 노드로 제한한다.
실험 전체 제한에는 정지·삭제한 arm의 보존 데이터도 포함한다. Eye는 문구·필드의
업무 의미를 모른다. 호스트의 관리 경계에서 게시할 형식을 검증한다.

## 선택과 적용

서버 `requestEye.data()`와 브라우저 `view.data()`는 같은 정의를 받는다.
`parse`는 서비스가 제공하는 검증·변환 함수다. 기본값은 parse를 거치지 않으며,
원격 데이터는 복사·JSON 검증한 뒤 parse에 전달하므로 캐시를 변경할 수 없다.

```ts
const selection = view.data({
  experimentId: 'landing-copy',
  defaultArm: 'control',
  defaultValue: DEFAULT_LANDING_COPY,
  parse: parseLandingCopy,
});
// 서비스가 selection.value를 실제 화면에 반영한 뒤 호출한다.
selection.expose();
```

기본 arm이 정책으로 선택되거나 유효한 default 증표를 사용하면 서비스의 기본값을
반환하고 해당 arm으로 관측·학습한다. 실험이 꺼져 있거나 유효한 권한이 없으면
같은 기본값을 반환하되 armId는 null이며 실험 참여를 기록하지 않는다.
비기본 arm의 데이터가 없거나 parse가 실패하면 `invalid_data`로 default 전환을
시도한다. default 권한도 없으면 미참여 기본값이다. 실패한 원래 arm을 노출했다고
기록하지 않는다. 과거 SDK/정책에 데이터가 없어도 이 규칙을 따른다.

브라우저 `view.dataAsync(definition, { maxWaitMs })`와 서버
`requestEye.data(definition, { maxWaitMs })`는 정책 준비 대기만 제한한다.
동기 브라우저 선택, 같은 view/placement의 선택 고정, 기존 배정 유지와
useDefault/expose 수명 규칙은 코드 실험과 같다. 서비스의 렌더링·로딩·함수를
Eye가 실행하지 않는다. 데이터 실험과 코드 실험을 같은 occurrence에 중복 호출하지 않는다.

## 전달·캐시·배포

발행 정책에 데이터가 포함되므로 서버 선택 시 추가 데이터 RPC가 없다.
브라우저 snapshot에는 선택된 arm의 데이터만 포함한다. 콘텐츠는 브라우저로
전달될 공개 값만 사용한다. 노출 증표·서명 상태·행동 이벤트·정책 이력에는
콘텐츠를 복사하지 않는다. arm ID가 불변 데이터의 성과를 구분한다.

정책의 기존 갱신·만료·원격 정지 지연을 유지한다. 이미 표시한 화면은 데이터나
설정 변경으로 자동 교체하지 않는다. 새 데이터 형식에는 서비스 배포가 필요하며,
이전 클라이언트의 parse가 거절할 수도 있으므로 형식 호환성을 유지한다.
새 런타임을 먼저 배포하고 SDK를 갱신한 뒤 데이터 arm을 등록한다.
선택·관측·보상 계산에는 새 가중치나 별도 콘텐츠 원장을 만들지 않는다.

## 준비 상태로 등록

`experiments.create({ ..., initialStatus: 'paused' })`는 실험을 원자적으로
일시중지 상태로 만든다. 객체 arm 입력도 `initialStatus: 'paused'`를 지원하므로
실행 중인 실험에 아직 검토 중인 arm을 추가할 수 있다. 생략하면 기존처럼 active다.
명시적 `resume`/`resumeArm` 전에는 새 정책의 선택 대상이 되지 않는다.
초기 상태는 최초 등록에만 적용하며 멱등 재요청으로 현재 상태를 덮어쓰지 않는다.
