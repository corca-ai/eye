# 서비스 코드에 Eye 연결하기

[문서 안내](README.md) · [설치와 등록](INTEGRATION.md) · [요청 API](api/client.md#createeyerequest) · [세션·SWR 계약](FAST-DECISIONS.md)

처음 연결한다면 설치·골·실험 등록 후 이 구조를 따른다. `createEyeRequest`는 페이지와 업무 사건용이고, 기존 `createEye`는 관리·분석·명시적 준비·신원 전환용이다. 기존 API를 교체할 필요는 없다.

## 서비스의 세 경계

| 위치 | 책임 | 예제 |
| --- | --- | --- |
| 공통 요청 처리 | 신원·토큰 연결, 오류 보고, 응답 쿠키 | [host.ts](../examples/host.ts)의 requestEye |
| 화면 | 변형 선택, 실제 적용 후 노출 | 같은 파일의 handlePage |
| 업무 사건 | 확정된 구매·가입·환불을 goal로 변환 | [business-events.ts](../examples/business-events.ts) |

페이지마다 `createEye`, subject, 토큰 저장, fallback 분기를 반복하지 않는다. 공통 요청 처리에서 요청별 `eye`를 만들고 페이지에 주입한다. 모듈 범위에서 공유하는 것은 정책 캐시와 실험 정의뿐이다. 사용자별 eye·토큰·선택 핸들을 전역에 저장하지 않는다.

```ts
// 공통 모듈의 정의. 등록 시에도 Object.keys(checkout.variants)를 사용한다.
const checkout = {
  experimentId: 'checkout',
  variants: { standard: 'standard', compact: 'compact' },
  fallback: 'standard',
} as const satisfies VariantDefinition<'standard' | 'compact'>;

// 페이지: eye는 요청 경계에서 주입된다.
const selection = await eye.variant(checkout);
const response = renderCheckout(selection.value);
selection.expose();
eye.track({ name: 'page_view', attributes: { path: '/checkout' } });
return finish(response);
```

`variant`는 원격 응답을 기다리지 않는다. 미준비·오류·서비스가 지원하지 않는 arm이면 fallback 값을 반환하고 armId는 null이다. 이때 expose는 null을 반환하며 아무 노출도 만들지 않는다. 지원하지 않는 arm과 SDK 오류는 onError로 보고한다. 정상적인 미준비는 오류로 보고하지 않으며 기존 decisions.onDecision으로 측정한다.

선택만으로 노출되지 않는다. SSR에서는 해당 응답을 구성한 뒤 expose를 호출한다. 동일 핸들의 반복 expose는 최초 결과를 반환하고 다시 제출하지 않는다. 첫 제출이 실패해도 재시도하지 않는다. 별개의 노출이면 새 선택 핸들을 사용한다. 핸들은 현재 요청에만 사용하며 직렬화하거나 다음 요청으로 넘기지 않는다.

experimentsEnabled:false는 로컬에서 선택·준비·노출을 끄고 track·goal은 유지한다. 이미 열린 관측의 귀속이나 다른 요청에서 시작한 준비를 취소하는 기능은 아니다. arm별 중지는 기존 관리 API를 쓴다.

## 세션 저장 선택

### 기존 서버 세션이 있는 서비스

인증에서 이미 읽은 세션 snapshot을 재사용한다. Eye 때문에 페이지 경로에 새 세션 RPC를 추가하면 SDK의 로컬 결정과 별개로 원격 지연이 생긴다.

[session.ts](../examples/session.ts)는 Durable Object 세션의 실행 가능한 참조 구현이다. 기존 세션 DO에 같은 방식으로 통합하거나 테스트에서 별도 클래스로 사용할 수 있다. Eye 설치가 이 클래스를 자동 배포하지는 않는다.

```ts
const adapter = eyeSessionAdapter(
  snapshot, // 기존 인증·세션 조회에 포함
  (epoch, id, token) => sessionStub.setToken(epoch, id, token),
);
// requestEye(request, env, ctx, adapter, authenticatedUid)
```

같은 세션의 실험별 쓰기를 합치고, 로그인·로그아웃·계정 변경 때 epoch를 교체하며 토큰을 비운다. 이전 epoch의 늦은 갱신은 저장하지 않는다. 인증 변경과 reset은 서비스의 동일한 직렬화 경계에서 처리한다. reset만 호출한다고 서비스 인증 변경까지 원자적으로 처리되지는 않는다. SDK identify/logout 접수와 기존 토큰 초기화는 별개의 작업이다.

### 서버 세션 없이 쿠키를 사용하는 서비스

[cookie-host.ts](../examples/cookie-host.ts)는 checkout 하나를 위한 GET 화면과 POST 준비 경로다. 요청의 쿠키로 로컬 선택을 하고, 실제 노출 후 state()의 서명 문맥을 응답 쿠키에 저장한다. 별도 준비 경로도 같은 쿠키를 갱신한다. 정책 준비 실패는 페이지 응답을 막지 않는다. 쿠키 저장을 위한 로컬 암호 연산은 응답 전에 기다린다. 토큰이 커서 쿠키 예산을 넘으면 오류를 보고하고 준비를 거절한다. 많은 실험은 요청 쿠키 크기를 키우므로 서버 세션 방식을 검토한다.

서비스 인증 계층은 로그인·로그아웃·계정 전환마다 바뀌는 불투명 scope를 전달한다. uid 자체를 scope로 쓰지 않는다. 서명된 인증 쿠키의 세대 값을 사용할 수 있으며 익명 세션에도 세대가 필요하다. scope별로 쿠키 이름이 달라져 이전 신원의 느린 준비 응답이 새 신원의 토큰을 덮어쓰지 않는다. 이전 쿠키는 만료까지 남을 수 있다. cid는 계속 별도로 유지하고 identify/logout을 전달한다.

브라우저는 페이지 표시 후 준비 경로를 호출한다. 아래는 한 탭의 최소 연결 예제다. 요청 중복 방지와 인증 전환 시 타이머 재시작은 사이트의 페이지 수명주기에 연결한다. 여러 탭에는 필요하면 서비스 수준의 중복 억제를 추가한다.

```js
let timer;
let stopped = false;
async function prepareCheckout() {
  let delay = 30_000;
  try {
    const response = await fetch('/eye/prepare-checkout', {
      method: 'POST', credentials: 'same-origin',
    });
    const body = await response.json();
    if (response.ok && Number.isFinite(body.retryAfterMs)) {
      delay = Math.max(1000, body.retryAfterMs);
    }
  } catch { /* 현재 화면은 유지하고 재시도한다. */ }
  if (!stopped) timer = setTimeout(prepareCheckout, delay);
}
void prepareCheckout(); // 렌더링을 기다리게 하지 않는다.
// 페이지 종료/인증 전환: stopped = true; clearTimeout(timer);
// 새 인증 상태가 준비되면 새 수명주기에서 다시 시작한다.
```

이 예제는 페이지 진입마다 준비를 한 번 요청한다. 불필요한 준비를 더 줄이려면 호스트가 준비 일정도 보관해야 한다. 준비 성공은 다음 요청부터 적용하며 현재 화면을 자동 교체하거나 노출을 생성하지 않는다. 토큰이 있어도 새 isolate의 정책 캐시가 비어 있으면 한 번 더 미참여할 수 있다. 개인별 응답은 공유 캐시에 넣지 않으며 예제는 private, no-store를 설정한다.

## 구매 웹훅과 지연 사건

구매가 확정됐을 때 생성한 업무 사건에 eventId, occurredAt, 원래 cid/uid와 금액을 고정한다. 주문 또는 서비스 outbox에 그 값을 저장하고 재전송에서도 그대로 사용한다. 웹훅 요청의 쿠키로 새 cid를 만들거나 현재 로그인한 관리자의 uid를 사용하지 않는다.

[business-events.ts](../examples/business-events.ts)의 reportPaidOrder는 이 경계를 보여준다. 결제 제공자 서명 확인과 업무 중복 처리는 서비스가 먼저 수행한다. Eye가 결제 성공 여부를 판단하지 않는다. cid가 없는 외부 사건을 임의의 cid로 기존 사용자에게 연결하지 말고, 주문 생성 때 신원 문맥을 저장한다.

createEyeRequest는 접수 거절과 비동기 전송 오류를 모두 onError로 보고하므로 페이지마다 반환값 검사 코드를 반복할 필요는 없다. Submission.accepted는 로컬 접수일 뿐 영속 저장 확인은 아니다. Queue 수신 확인 후 작업을 완료해야 하는 job은 createEye와 await flush()를 사용한다. 분석 반영까지 기다리는 것은 아니다.

## SPA의 실제 표시

CSR에는 [브라우저 SDK와 서버 증표 처리](CSR.md)를 사용한다. 서버용 selection 핸들을 직렬화하지 않고 브라우저 전용 클라이언트가 별도 뷰·노출 핸들을 만든다. 프리페치·취소된 라우트는 노출로 기록하지 않는다. 서버 수신기는 암호화된 증표를 검증해 원래 배정과 신원으로 expose를 호출한다. 서비스는 인증 경계와 실제 표시 시점을 연결한다.

## 작은 도입 점검

기본 화면 → 준비 성공 뒤 변형 → 명시적 노출 → goal → 분석 순서로 확인한다. 준비 실패·변조 토큰·지원하지 않는 arm에서는 기본 화면이 유지되어야 한다. 로그인 중 늦은 갱신이 새 세션을 덮어쓰지 않는지도 확인한다. 설치와 저수준 API의 상세 순서는 [연동 가이드](INTEGRATION.md), 집계 해석은 [분석 가이드](ANALYTICS.md)를 따른다.
