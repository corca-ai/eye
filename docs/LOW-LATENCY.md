# 지연을 줄이는 실험 적용

[연동](INTEGRATION.md) · [브라우저](CSR.md) · [분석](ANALYTICS.md)

페이지, 늦게 로딩하는 요소, 이미 로딩한 함수, 서버 API는 같은 순서를 사용한다.
Eye가 값을 선택하고 호스트가 실제 적용한 뒤 `expose()`를 호출한다. `variants`의
값은 컴포넌트·loader·함수·키 등이며 SDK가 실행하거나 import하지 않는다.
업무 성공은 별도의 서버 `goal()`로 기록한다. [타입 검사되는 예제](../examples/low-latency.ts)를 참고한다.

## 기본은 기다리지 않기

기존 `fallback`은 배정 없는 제품 기본 동작이다. 명시적인 `defaultArm`을 사용하면
유효한 default 권한이 있을 때 해당 arm의 실제 참여로 기록한다. 미준비·성능 우회를
정책의 무작위 배정으로 기록하지 않는다. 기본 arm은 `variants`에도 있어야 한다.

```ts
const definition = {
  experimentId: 'landing', defaultArm: 'control',
  variants: { control: 'control', alternative: 'alternative' },
};
const view = eye.beginView();
const selected = view.variant(definition); // 동기: 준비된 정책, 또는 유효한 default
render(selected.value); // 호스트 함수
selected.expose();
```

`eye.prepare(['landing'])`으로 준비를 명시적으로 시작하고 기다릴 수도 있다. 선택·노출은
발생하지 않으며 진행 중인 요청과 상태를 공유한다. 한 번에 최대 20개다. 준비 결과는
실험별 assigned/inactive/unavailable이며 전송 실패는 onError에도 전달된다.

부분 요소처럼 로딩 대기를 원래 갖는 곳에서는 코드·데이터 로딩과 준비를 겹친다.
`view.variantAsync(definition, { maxWaitMs: 80 })`은 준비를 제한된 시간만 기다린 뒤
선택을 고정한다. 80ms는 예시다. 지점별 예산은 실측으로 정한다. 늦게 도착한 준비
결과는 다음 occurrence에만 사용하며 이미 표시한 페이지를 바꾸지 않는다.
서버는 `requestEye.variant(definition, { maxWaitMs: 0 })`로 정책 RPC를 기다리지 않는다.
로컬 서명·검증 비용은 남으며, 양수 예산은 준비 네트워크 대기를 제한한다.

선택된 리소스가 실제 적용 전에 준비되지 않았다면
`selected.useDefault('resource_unready')`를 사용한다. 서버에서는 Promise이므로 await한다.
기존 선택은 적용 불가해지고 다른 배정의 default 핸들을 돌려준다. 같은 occurrence에서
반복 호출은 같은 대체 핸들을 사용한다. 이미 적용한 함수/API 부수효과를 다른 arm으로
재실행하는 용도가 아니다. 미지원 arm·비활성 실험·권한 오류를 default 참여로 바꾸지 않는다.

## 네트워크 없이 default를 허용하는 권한

호스트 서버는 신뢰된 `PublishedPolicy` snapshot을 `decisions.initialPolicies`로 주입할 수
있다. 기존 정책 발행물에 설치 ID, generation, 설정, 상태, arm 목록이 이미 있으므로
별도 default 설정 원장이나 리소스를 만들지 않는다. SDK가 유효성과 원래 발행 나이를
확인한다. default는 활성 정책에 등록된 활성 arm이어야 한다. 갱신은 원래 publishedAt을
연장하지 않는다. 공유 저장소에서 snapshot을 읽기 위해 대기한다면 그 원격 비용은
호스트 지연이며 zero-I/O라고 주장하지 않는다.

브라우저 서버 어댑터에 `defaultArms: { landing: 'control' }`를 설정하고
`server.snapshot(['landing'], states, defaultStates)`를 호출하면 로컬 캐시와 암호 연산으로
초기 정책 선택/default 증표를 만들 수 있다. 이 호출은 정책 RPC를 기다리지 않는다.
실제 snapshot 주입이 없는 cold isolate에는 권한이 저절로 생기지 않는다.
`server.prepare(ids, states, defaultStates)`는 필요할 때 정책 조회를 기다리고 권한도 갱신한다.
HTTP 어댑터는 브라우저 요청의 `defaultStates`를 세 번째 인자로 넘겨야 한다.

호스트가 subject, 서명/인증된 browserBinding, auth scope를 확정한다. defaultArms와
initialPolicies는 서버 설정이며 브라우저 JSON을 그대로 사용하지 않는다. 초기 snapshot은
개인별 응답이므로 private,no-store와 올바른 ETag/304 처리가 필요하다. 익명 첫 화면에 UID를
붙이려고 새 인증 조회를 추가하지 말고 CID로 발급한 뒤 기존 로그인 identify로 연결한다.
인증된 권한은 이미 인증을 읽는 bootstrap에 포함한다. 실제 가입 골의 신원 연결도 별도 구현이다.

브라우저 `initialAgeMs`에는 서버 snapshot 생성 이후 경과 시간(전송 포함)을 전달할 수 있다.
생략하면 현재 벽시계와 serverNow 차이를 보수적으로 사용하므로 서버/기기 시계 차이가 영향을
줄 수 있다. 초기 권한은 새 클라이언트를 만들 때마다 수명이 늘어나지 않는다.

`BrowserSnapshot.defaults`는 정책 choices와 독립적인 암호화 증표다. 정상 prepare에서
각각 갱신한다. 관련 선택 시 stale 권한은 백그라운드 갱신하지만 전체 탭의 무조건 주기
타이머는 넣지 않는다. 만료된 증표로 새 적용을 기록할 수 없으며 네트워크도 끊겼다면
제품의 안전한 기본 화면은 제공하되 실험 참여는 보장하지 않는다. 원격 pause는 정책 lease
지연을 갖는다. 즉시 중단은 호스트 flag로 선택·실험 적용·노출을 함께 끈다.

## 실제 적용과 관측

페이지는 실제 commit, 요소는 mount, 함수/API는 해당 분기의 실제 진입에서 expose한다.
프리페치·취소·미사용 선택은 노출이 아니다. 이벤트 ID는 재전송에 유지한다.

서버 정책 `state()`와 별개로 `defaultState()`/`decisions.defaultTokens`를 저장한다.
`onDefaultPrepared`도 별도다. 브라우저는 기본적으로 sessionStorage에 둘을 독립 저장한다.
같은 신원/scope·실험·generation·default arm·관측 설정의 default는 최초 실제 적용에서
관측을 시작하고 그 관측이 끝날 때까지 view/placement 사이에서도 sample을 재사용한다.
권한 갱신이나 우회 이유 변경이 관측 기간을 늘리지 않는다. 정책/default 문맥을 서로
덮어쓰지 않으므로 default→policy→default에서도 살아 있는 default 관측을 이어간다.
새 navigation은 저장된 유효 default 증표와 관측을 먼저 이어가며 백그라운드로 갱신한다.
기존 증표가 만료된 열린 관측은 새 assignment로 바꿔치기하지 않고 준비로 복원해야 한다.
그 복원 전에 표시한 제품 기본 동작은 미참여일 수 있다. 권한 만료는 이미 기록된 관측/골 귀속 이력을 지우지 않는다. 기기 간 배정 일치는 보장하지 않는다.

## 분석·학습과 해석

새 default assignment는 `allocation: 'default'`, `probability: null`, `policyRevision: null`을
갖는다. 정책 선택 확률을 default에 복사하지 않는다. 기존 allocation 없는 데이터는 policy다.
실제 우회 이유는 각 exposure의 defaultReason에 기록한다.

`arms`, `armSeries`, `traffic`은 allocationMode를 별도 차원으로 반환하며 동일 이름의 필터를
지원한다. default에도 노출·관측·raw 골 귀속이 있지만 learningValue는 null이다.
`learning()`과 선택적 learning summary는 policy-only다. default도 최신 노출과 동시 실험의
귀속 분모에 남긴 뒤, 완료 표본을 정책 moments로 더하는 마지막 경계에서만 제외한다.
따라서 default 뒤의 골이 과거 정책 arm으로 잘못 되돌아가거나 다른 실험의 보상이 부풀지
않도록 한다. 이 설명은 사건이 처리된 순서의 범위이며 아래 수신 순서 한계가 있다.

정책 표본도 실제로 적용된 집단의 결과다. 느린 B를 적용하지 못하고 A-default를 사용하면
B에 직접 실패 벌점이 생기는 것은 아니다. 이 분리만으로 unbiased uplift나 리소스 준비까지
포함한 종단 최적화를 주장하지 않는다. default율·우회 이유·전달 품질을 함께 관찰한다.

현재 학습은 배치 안에서만 (occurredAt,eventId)로 정렬한다. goal이 먼저 도착하면 나중
exposure로 이미 처리한 보상을 되돌리지 않는다. 브라우저 노출과 API 골의 순서 역전·유실은
실시간 학습에 영향을 주며 raw 재귀속과 frozen learning이 다를 수 있다. 전역 replay는
이 변경에 포함하지 않는다. 같은 필수 API 요청에 증표를 동봉하는 더 강한 인과 연결은
호스트가 별도 설계해야 하며, 같은 ms의 eventId tie-break도 고려해야 한다.

## 배포 호환성

새 assignment는 null 확률과 default 문맥을 포함하므로 기존 runtime에 먼저 보내지 않는다.
새·구형 사건을 읽는 runtime을 먼저 배포하고 호스트 SDK를 갱신한다. 기존 receipt·Queue
사건은 계속 읽는다. 기존 테이블·Stream 스키마는 유지하지만 JSON reader와 타입은 함께
갱신해야 한다. 실험을 사용하지 않는 호스트의 기존 track/goal 호출은 그대로다.
