# 사이트 연동 가이드

[문서 안내](README.md) · [API 레퍼런스](api/client.md) · [타입·설정 기본값](api/types.md) · [분석 해석](ANALYTICS.md)

사이트는 Cloudflare Worker에서 Eye를 호출한다. Eye가 제공하는 것은 서버 SDK·배정·수집·관리·분석 API이며, 브라우저 이벤트 수집과 관리자 UI는 사이트가 만든다. 실제 계정 배포·대규모 분석 성능은 아직 검증하지 않았다.

## 1. 설치

Node.js 22 이상을 사용한다. 아직 npm에 게시하지 않았으므로 저장소에서 패키지를 만든다.

```sh
git clone https://github.com/corca-ai/eye.git
cd eye
npm ci
npm run build
npm pack
```

사이트 프로젝트에서 실행한다.

```sh
npm install /path/to/eye/eye-workers-0.1.0.tgz
npm install -D wrangler@4.151.3
npx eye init ./eye --account-id YOUR_ACCOUNT_ID --name shop-eye
```

생성된 `eye/README.md`를 읽고 Cloudflare 인증, Catalog 생성·쓰기용 `EYE_CATALOG_TOKEN`, 분석 조회용 `EYE_ANALYTICS_TOKEN`을 환경에 설정한다. 토큰은 설정 파일에 적지 않는다. 리소스 구성과 재시도 절차는 [설치 템플릿](../templates/README.md)에 있다.

```sh
node eye/provision.mjs
```

이 명령은 계정에 Eye 리소스와 보조 Worker를 만든다. 사이트 Worker 설정에 Service Binding을 추가하고 사이트를 기존 배포 절차로 배포한다.

```json
{ "services": [{ "binding": "EYE", "service": "shop-eye" }] }
```

보조 Worker의 HTTP는 404를 반환한다. 아래 SDK 호출은 사이트 서버에서 Service Binding으로 실행한다. 관리·분석 HTTP 경로를 만들 경우 사이트의 관리자 인증을 적용한다.

## 2. 골과 실험 등록

신뢰할 수 있는 초기 설정 작업이나 관리자 경로에서 실행한다. `env`, `ctx`는 사이트 Worker의 바인딩과 현재 실행 컨텍스트다. 이 예제는 이후에도 같은 `siteId`를 사용한다.

```ts
import { createEye } from '@eye/workers';

const eye = createEye({ service: env.EYE, ctx, siteId: 'shop' });
await eye.goals.create('purchase');
await eye.goals.create('signup');
await eye.goals.create('refund');
await eye.experiments.create({
  experimentId: 'checkout',
  arms: ['standard', 'compact'],
  settings: { minHoldMs: 86_400_000 }, // 배정 후 최소 하루 유지
});
```

골은 ID만 등록한다. 언제 달성했는지와 가치는 서비스가 전달하며, 모든 실험은 같은 사이트의 골을 사용한다. 모든 골의 가치 단위를 통일한다.

`minHoldMs`만 필수다. 기본 관측 기간은 7일이므로 위 설정이 매일 재배정을 의미하지는 않는다. 첫 실제 노출로 관측이 시작하고, 일반 재배정은 최소 유지·관측 종료·토큰 안전 유지 조건이 모두 충족된 뒤 가능하다. 구매 주기와 변화 속도에 맞춰 관측 기간, 귀속 반감기, 학습 반감기를 설정한다. [전체 설정·기본값·제약](api/types.md#experimentsettings)을 참고한다.

같은 최초 실험 정의의 재등록은 안전하지만 다른 정의로 덮어쓰지는 않는다. 변경에는 `experiments.update()`를 사용한다. 설정이 바뀌면 새 학습 세대를 시작하고 기존 배정 설정은 보존한다.

## 3. cid·uid와 서버 세션 연결

전체 핸들러의 타입 검사되는 예제는 [examples/host.ts](../examples/host.ts)에 있다. 다음 준비물이 필요하다.

- `EYE_DECISION_SECRET`: 호스트 secret으로 저장한 최소 32바이트의 무작위 비밀 값. 브라우저에 전달하지 않는다.
- `session.decisionTokens`: 현재 사용자 세션의 실험 ID → 서명 토큰 맵.
- `session.setDecisionToken(id, token)`: 서버 세션의 해당 항목을 저장하는 함수. 동시 요청이 다른 실험의 토큰을 지우지 않도록 항목 단위 갱신한다.
- `uid`: 사이트 인증 결과. 익명 사용자는 uid 속성을 생략한다. 수집·배정에는 cid도 항상 전달한다.

```ts
import { createEye, DecisionCache, getOrCreateCid } from '@eye/workers';

const policies = new DecisionCache(); // 모듈 범위, 사용자 데이터는 넣지 않음

// 아래는 요청 핸들러 내부
const cookie = getOrCreateCid(request);
const subject = uid === undefined ? { cid: cookie.cid } : { cid: cookie.cid, uid };
const eye = createEye({
  service: env.EYE, ctx, siteId: 'shop',
  onError: error => console.error('Eye delivery failed', error),
  decisions: {
    secret: env.EYE_DECISION_SECRET,
    cache: policies,
    tokens: session.decisionTokens,
    onPrepared: (id, token) => session.setDecisionToken(id, token),
  },
});
```

응답 반환 전에 `cookie.setCookie`가 있으면 `response.headers.append('Set-Cookie', cookie.setCookie)`로 추가한다. `onPrepared`는 응답 후 실행될 수 있으므로 이미 보낸 응답 쿠키를 수정할 수 없다. 서버 세션이 없다면 명시적 `await eye.prepare(...)` 결과의 token을 응답 전에 저장하는 별도 준비 경로가 필요하며, 이 호출은 중앙 응답을 기다린다. [세션·SWR 계약](FAST-DECISIONS.md)을 참고한다.

로그인 시 `eye.identify({ subject: { cid, uid } })`, 로그아웃 시 `eye.logout({ subject: { cid } })`을 호출한다. 로그인·로그아웃·계정 변경 시 이전 배정 토큰도 비운다. uid의 기존 배정을 우선하며, uid에 없는 실험은 cid의 배정과 누적 보상을 인계한다. 신원 전환을 이유로 이미 보낸 골을 다른 subject로 다시 보내지 않는다.

## 4. 화면 적용과 사건 수집

```ts
const decision = await eye.decide({ subject, experimentId: 'checkout' });
const armId = decision.status === 'assigned'
  ? decision.assignment.armId : 'standard';

// renderCheckout은 사이트 함수: armId에 맞는 화면을 실제로 제공한다.
const response = renderCheckout(armId);
if (cookie.setCookie) response.headers.append('Set-Cookie', cookie.setCookie);
if (decision.status === 'assigned') {
  eye.expose({ subject, decision, userAttributes: { device: 'mobile', locale: 'ko' } });
}
eye.track({ subject, name: 'page_view', attributes: { path: '/checkout' } });
```

`decide`는 원격 응답을 기다리지 않는다. cold·미준비·만료 상태는 `unavailable`, 실험이 비활성이거나 활성 arm이 없으면 `no_active_arm`을 반환할 수 있다. 두 경우 모두 기본 화면을 사용하고 노출을 기록하지 않는다. `onPrepared`는 건너뛴 요청에서 다음 요청을 준비한다. 기본 정책은 60초 이후 백그라운드 갱신하며 발행 후 최대 5분까지 재사용한다.

`userAttributes`는 arm 비교용 사용자군 속성이고 첫 노출 때 관측에 고정된다. `attributes`는 개별 사건 속성이다. 두 값 모두 최상위 키와 scalar 값만 허용한다. SPA처럼 표시 사실을 브라우저만 알 수 있으면 사이트 수집 경로가 실제 표시 시점에 `expose`를 호출해야 한다. Eye는 DOM 표시 여부를 감지하지 않는다.

구매 확정 등 업무 사건이 발생한 경로에서 호출한다. 다음 변수는 사이트의 주문·환불 데이터다.

```ts
eye.goal({ subject, eventId: `purchase:${order.id}`, goalId: 'purchase', value: order.amount });
eye.goal({ subject, eventId: `signup:${uid}`, goalId: 'signup', value: 10_000 });
eye.goal({ subject, eventId: `refund:${refund.id}`, goalId: 'refund', value: -refund.amount });
```

`occurredAt` 생략 시 현재 Unix 밀리초를 사용한다. 지연 전달이면 실제 발생 시각을 전달한다. 재시도에는 동일한 eventId·subject·payload를 사용한다. goal 중지·삭제는 수신 시각이 아니라 발생 당시 상태로 판정한다.

## 5. 결과 확인과 운영

```ts
const to = Date.now(), from = to - 7 * 86_400_000;
const policy = await eye.experiments.policy('checkout');
const report = await eye.analytics.arms({
  experimentId: 'checkout', from, to,
  groupBy: [{ key: 'device', type: 'string' }],
});
const traffic = await eye.analytics.traffic({
  experimentId: 'checkout', from, to, bucketMs: 86_400_000,
});
const goals = await eye.analytics.goals({ from, to });
const timeline = await eye.analytics.timeline({
  from, to, subject: { uid: 'user-123' }, limit: 100,
});
```

`report.rows`의 `completed/pending/interrupted`와 `meanValue`를 함께 본다. 관측이 끝나기 전에는 완료 평균이 없을 수 있다. `policy`는 현재 중앙 선택 정책, `traffic`은 실제 배정·노출, `analytics.policies`는 발행 정책 이력이다. 분석에는 반영 지연이 있으며 평균 차이는 인과적 uplift가 아니다. [조회별 의미·응답·필터 예제](ANALYTICS.md)를 참고한다.

arm을 추가하려면 `experiments.addArm(id, armId)`, 잠시 멈추려면 `pauseArm/resumeArm`, 실험 전체는 `pause/resume`을 사용한다. `delete/deleteArm`은 이력을 보존하는 영구 비활성화이며 ID 재사용을 금지한다. 로컬 결정에는 정책 갱신 지연이 있다. 골도 `goals.pause/resume/delete`로 관리한다.

## 오류와 첫 연동 점검

수집과 대기 API의 실패를 구분한다.

```ts
const result = eye.track({ subject, name: 'page_view' });
if (!result.accepted) console.error(result.error.code, result.error.message);
// 필요할 때만: await eye.flush(); // Queue 수신을 기다림. 분석 반영까지 기다리지는 않음.
```

수집은 로컬 검증 실패를 `Submission`으로 반환하고 비동기 전송 오류를 `onError`로 보고한다. 관리·조회·prepare는 Promise가 reject될 수 있으므로 호출 경로에서 catch한다. RPC 경계를 포함한 오류는 `instanceof`만 가정하지 말고 가용한 code/message를 확인하며, code가 없는 전송 오류도 처리한다. [공개 오류 코드](api/types.md#errorcode)는 `invalid_input`, `not_found`, `conflict`, `deleted`, `outside_retention`, `numeric_range`, `unavailable`이다. message 문자열을 조건 분기에 사용하지 않는다.

| 증상 | 먼저 확인할 것 |
| --- | --- |
| 계속 unavailable | secret, 세션 토큰 저장·다음 요청 읽기, onPrepared 오류. 설정 없는 decide는 자동 참여하지 않음 |
| no_active_arm | 실험 상태와 활성 arm, 로컬 정책 갱신 대기 |
| 골은 있는데 arm 완료 평균이 없음 | 실제 expose, 관측 종료와 allowedLatenessMs, 귀속 범위 |
| 속성별 결과가 예상과 다름 | expose.userAttributes와 사건 attributes 구분, 최초 노출 시점의 값 |
| 분석 결과가 비거나 이전 값임 | 같은 siteId, 분석 토큰·파이프라인, 최종 일관성, 최근 60일 범위 |
| 일부 결과만 보임 | meta.truncated 확인 후 기간·arm·속성 조건 축소 |

운영 전 `onDecision`으로 미준비 참여 누락을 지역·신규/재방문별로 측정한다. 목표와 측정 범위는 [빠른 배정 운영 계약](FAST-DECISIONS.md#운영-목표와-측정)에 있다.
