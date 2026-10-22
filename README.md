# Eye for Cloudflare Workers

서비스 소유의 Cloudflare 인프라에서 동작하는 웹로그 분석 및 지속형 MAB 라이브러리다. 서비스가 로그·노출·goal 발생을 알려주며, 모든 실험은 같은 사이트 goal value를 학습한다.

현재 수집·배정·학습·분석 API와 설치 구성이 구현되어 있다. 로컬 검증을 진행 중이며, 실제 Cloudflare 배포·대규모 조회·지역별 지연을 검증한 운영 릴리스는 아니다. 남은 작업은 아래 구현 상태에 기록한다.

- [문서 안내](docs/README.md)
- [요구사항](DESIGN.md)
- [기술 설계](TECHNICAL_DESIGN.md)
- [항목별 구현 상태와 검증](docs/IMPLEMENTATION.md)
- [설계 시뮬레이션](docs/SIMULATION.md)
- [분석 API 계약](docs/ANALYTICS.md)
- [호스트 연동 예제](examples/host.ts)

## 설치

현재 레지스트리에 게시하지 않았다. 아래 명령으로 tarball을 만든 뒤 호스트 프로젝트에 설치한다.

```sh
git clone https://github.com/corca-ai/eye.git
cd eye
npm ci
npm run build
npm pack
```

```sh
npm install /path/to/eye-workers-0.1.0.tgz
npm install -D wrangler@4.151.3
npx eye init ./eye --account-id YOUR_ACCOUNT_ID --name shop-eye
```

`init`은 로컬 설정·Stream 스키마·분기 SQL·설치 스크립트를 만든다. 생성된 `eye/README.md`를 확인하고 Cloudflare 인증과 토큰을 설정한 뒤 `node eye/provision.mjs`를 실행하면 자신의 계정에 리소스를 만들고 Eye Worker를 배포한다. 보조 Worker는 HTTP를 공개하지 않으며 Service Binding으로 호출한다. 기존 앱의 fetch·queue 핸들러를 대체하지 않는다.

호스트 Wrangler 설정에 `{"services":[{"binding":"EYE","service":"shop-eye"}]}`를 추가한다. 바인딩 타입은 Wrangler로 생성하거나 `EyeService`를 사용한다. 호스트가 공개할 분석·관리 HTTP 경로의 인증·권한 검사는 호스트의 책임이다.

## 개발

Node.js 22 이상에서 다음을 실행한다.

```sh
npm ci
npm run types
npm run check
npm run check:package
npm run benchmark
```

`npm run check`는 엄격한 TypeScript 검사, 순수 로직 검사, 실제 workerd/SQLite Durable Object 검사, 선언 파일과 JavaScript 빌드를 수행한다. 원격 Cloudflare 리소스는 만들지 않는다. `npm run types`로 생성한 바인딩 타입은 라이브러리 선언 파일에도 포함되므로 호스트 프로젝트의 전역 `Env` 타입에 의존하지 않는다.

`npm run benchmark`는 로컬 Node.js에서 선택 정책의 순수 계산 비용만 측정한다. Cloudflare 네트워크·저장소 지연, 전체 요청 지연, 운영 비용의 측정값이 아니다.

## API 규칙

식별자는 사이트별로 구분하며, uid를 알면 uid가 배정의 기준이다. 일반 API의 시각은 Unix 밀리초이고 설정의 기간은 `Ms` 접미사를 사용한다. HTTP 쿠키 수명은 `maxAgeSeconds`로 별도 명시한다. goal value는 유한한 양수·0·음수를 받으며 임의로 자르거나 로그 변환하지 않는다.

쿠키 생성을 서비스가 원할 때 사용할 수 있는 서버 보조 함수는 다음과 같다.

```ts
import { getOrCreateCid } from '@eye/workers';

const { cid, setCookie } = getOrCreateCid(request);
// uid는 서비스의 인증 결과에서 공급한다.
if (setCookie) response.headers.append('Set-Cookie', setCookie);
```

요청마다 클라이언트를 생성하고, 호스트가 실제 적용한 arm과 업무 이벤트를 알린다.

```ts
const eye = createEye({ service: env.EYE, ctx, siteId: 'shop', onError: console.error });
const subject = uid === undefined ? { cid } : { cid, uid };
const decision = await eye.decide({ subject, experimentId: 'checkout' });
if (decision.status === 'assigned') {
  // 호스트가 decision.assignment.armId를 실제 적용한 뒤 호출한다.
  eye.expose({ subject, decision, userAttributes: { locale: 'ko' } });
}
eye.track({ subject, name: 'page_view', attributes: { path: '/checkout' } });
eye.goal({ subject, eventId: 'purchase:order-123', goalId: 'purchase', value: 50_000 });
```

`decide`는 배정 일관성을 위해 RPC를 기다린다. `unavailable`·`no_active_arm`이면 호스트가 기본 화면을 선택하고 가짜 노출을 기록하지 않는다. 수집 함수는 동기적으로 `{ accepted, eventId }` 또는 검증 오류를 반환하고 전송은 요청의 `ctx.waitUntil()`에서 처리한다. `accepted`는 로컬 검증 성공이다. Queue 수신 확인이 필요한 작업에서는 `await eye.flush()`를 사용한다. `onError`는 비동기 전송 오류를 받는다.

재시도에는 동일한 event ID·subject·payload를 전달한다. 로그인했다고 이전 goal을 새 uid로 다시 보내지 않는다. `identify({ subject: { cid, uid } })`, `logout({ subject: { cid } })`로 신원 전환을 알린다.

## 관리와 분석

goal·실험 등록은 매 요청이 아닌 신뢰할 수 있는 관리 경로에서 수행한다.

```ts
await eye.goals.create('purchase');
await eye.goals.create('refund');
await eye.experiments.create({
  experimentId: 'checkout', arms: ['standard', 'compact'],
  settings: { minHoldMs: 86_400_000 },
});
await eye.experiments.addArm('checkout', 'express');
await eye.experiments.pauseArm('checkout', 'standard');

const to = Date.now(), from = to - 30 * 86_400_000;
const report = await eye.analytics.arms({
  experimentId: 'checkout', from, to,
  groupBy: [{ key: 'locale', type: 'string' }],
});
const timeline = await eye.analytics.timeline({ from, to, subject: { uid }, limit: 100 });
const daily = await eye.analytics.series({ from, to, bucketMs: 86_400_000 });
```

`experiments.update/resumeArm/get/list/policy`, `goals.pause/resume/delete/get/list`도 제공한다. 설정 변경은 새 학습 세대를 시작하며 기존 관측 설정과 arm의 최소 유지 기간을 보존한다. arm 중지는 다음 조회부터 최소 유지보다 우선한다.

분석은 최근 60일의 `arms`, `timeline`, `goals`, `series`, `attributeValues`를 제공한다. 결과는 최종 일관성이며 수신 시각의 최댓값을 전체 데이터 수신 완료 시각으로 해석하면 안 된다. 평균 차이는 탐색용이고 인과적 uplift가 아니다. 상세 계약은 [분석 문서](docs/ANALYTICS.md)를 참고한다.

## 라이선스

[MIT](LICENSE) © 2026 Corca, Inc.
