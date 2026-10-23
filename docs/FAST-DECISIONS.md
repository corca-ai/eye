# 빠른 배정 API

`decide()`는 원격 응답을 기다리지 않는다. HMAC 검증 등 로컬 CPU 작업만 기다리고, fresh 정책과 서명된 준비 상태가 있으면 같은 arm을 반환한다. 없으면 `unavailable`을 반환하고 기본 화면을 사용한다. 이 경우 가짜 노출을 기록하지 않는다.

## 호스트 연동

호스트 secret `EYE_DECISION_SECRET`에 최소 32바이트의 무작위 비밀 값을 둔다. 브라우저에 전달하지 않는다. `DecisionCache`는 서비스 바인딩 하나당 하나를 isolate에서 재사용해 정책만 저장한다. 사용자별 토큰은 호스트 세션에 보관한다.

```ts
const policies = new DecisionCache(); // module scope, no user data
// request scope
const eye = createEye({ service: env.EYE, ctx, siteId: 'shop',
  decisions: {
    secret: env.EYE_DECISION_SECRET,
    cache: policies,
    tokens: session.decisionTokens,
    onPrepared: (experimentId, token) => session.setDecisionToken(experimentId, token),
    onDecision: metric => metrics.record({ ...metric, region, newVisitor }),
  },
});
const decision = await eye.decide({ subject, experimentId: 'checkout' });
```

`session`과 `metrics`는 호스트가 제공하는 기능이다. `onPrepared`는 `waitUntil` 안에서 실행되므로 이미 보낸 응답의 쿠키 헤더를 수정하는 용도로 사용하지 않는다. 서버 세션에 저장하거나, 명시적으로 `await eye.prepare(...)`한 결과의 `token`을 응답 전에 저장한다. 인증·로그아웃·계정 전환 때 세션의 기존 토큰을 비운다. uid 토큰은 해당 uid의 기기 사이에서 공유할 수 있고 익명 토큰은 cid에 묶인다. 토큰은 site·실험·subject·배정·만료에 서명되며 위조·다른 신원·만료 상태는 미참여로 처리한다.

`prepare()`는 중앙 조정·신원 인계를 기다리는 명시적 API다. 필요하면 호스트 인증 작업과 겹쳐 실행한다. 기본 `decide()`는 prepare의 완료를 기다리지 않는다. `onPrepared`가 없으면 자동 배정 준비는 하지 않으며 호스트가 직접 prepare를 호출해야 한다. 기존 대기 방식이 필요한 연동에는 `decideConsistent()`를 제공한다. 이 API는 원격 RPC를 기다린다.

## 최신성과 재시도

기본 fresh 기간은 60초, 최대 정책 나이는 발행 후 5분이다. `freshMs`, `maxAgeMs`로 조정한다. 60초부터 만료 전까지는 기존 정책으로 반환하며 갱신한다. 같은 발행 sequence를 다시 읽어도 나이를 연장하지 않는다. 실패 시 갱신 시작을 10초간 억제하고 요청 간 진행 중 I/O Promise를 공유하지 않는다. 캐시는 기본 최대 1,000개 정책이며 작은 사이트에도 무한히 쌓이지 않는다.

현재 정책 배포는 Experiment DO가 최대 분당 한 번 영속화하는 발행본과 호스트의 메모리 캐시를 사용한다. 갱신 RPC는 백그라운드에서만 수행한다. KV를 추가하는 제안은 이번 구현에 필수로 넣지 않았다. 중앙 신규 선택·pending 예약과 shard 갱신 알고리즘은 유지한다. 정책 조회·준비가 없는 실험은 발행 이력을 자동 생성하지 않는다.

중지·삭제를 알게 된 정책에서는 해당 arm을 재사용하지 않는다. 오래된 유효 정책에서는 발행 후 최대 5분까지 이전 상태가 보일 수 있다. 서버가 새 배정을 준비할 때는 현재 운영 상태를 확인한다.

## 관측과 동시 요청

로컬 재사용 토큰은 최대 5분이며, 이미 열린 관측이 있으면 그 종료 시각을 넘지 않는다. 실제 노출은 기존 `expose()`로 전달한다. 준비 자체는 관측이나 완료 0 표본을 만들지 않는다.

첫 노출이 Queue에 남아 있을 때 다른 요청이 재배정하는 것을 막기 위해 Subject는 토큰이 허용하는 마지막 노출에서 시작할 수 있는 관측까지 배정을 보수적으로 유지한다. 관측이 확인되면 후속 토큰은 그 고정 종료 시각에 맞춘다. 첫 노출이 신속히 수신되면 최초 토큰 때문에 일반 재배정이 실제 관측 종료보다 최대 5분 늦어질 수 있다. Queue가 지연되는 동안 준비를 반복하면 그 지연만큼 더 길어질 수 있다. 그 경계에서 안전한 준비가 불가능하면 미참여하며, 관측 기간 W 자체를 늘리거나 이미 시작한 관측의 경계를 바꾸지 않는다. arm 중지와 uid 충돌은 유지보다 우선한다. W가 매우 짧은 실험은 이 보수적 대기 때문에 미참여율이 커질 수 있어 배포 전 확인해야 한다.

미참여는 arm 전환·노출·완료 0으로 기록하지 않는다. 이미 열린 관측은 유지하며, 그 사이 서비스 기본 화면에서 발생한 goal도 기존 귀속 규칙을 따른다. 이 희석 효과와 사용자군별 편중은 운영 검증 대상이다.

## 운영 목표와 측정

실험별 참여 대상 요청 중 정책·배정 미준비로 건너뛴 비율의 목표는 1% 이하이다. `onDecision`은 결정마다 outcome·reason·experimentId·인증 여부·시각을 제공한다. 호스트는 지역·신규/재방문 여부를 함께 붙여 집계한다. 중지된 실험의 `no_active_arm`은 참여 대상 미준비와 구분한다. 목표 초과를 감지하면 세션 저장·준비 시점을 개선하며 자동으로 응답 대기를 추가하지 않는다. 콜드 세션이 많은 배포에서는 이 목표가 충족되지 않을 수 있다. 현재 로컬 검사는 원격 대기가 없다는 동작을 검증하며 1% 달성이나 운영 p99를 실측한 결과가 아니다.
