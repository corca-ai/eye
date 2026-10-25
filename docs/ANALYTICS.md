# 분석 API 계약

[연동 가이드](INTEGRATION.md) · [API 시그니처](api/client.md#eyeanalyticsarms) · [응답 타입](api/types.md#armreport) · [문서 안내](README.md)

`createEye(...).analytics`는 서버 Service Binding을 통해 고객 계정의 Basin SQL을 호출한다. 토큰은 Eye Worker secret에만 둔다. UI와 공개 HTTP API는 호스트가 구성한다.

## 비동기 조회와 결과 재사용

운영자 화면의 무거운 조회에는 `analytics.jobs`를 사용한다. 기존 동기 메서드도 그대로 지원한다.

```ts
// 호스트가 인증·조회 권한과 조건을 검증한 후 정한 값이다.
const scope = 'analytics-admins-v1';
const to = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const job = await eye.analytics.jobs.create({ scope,
  request: { kind: 'arms', query: { experimentId: 'hero', from: to - 86_400_000, to } },
});
const state = await eye.analytics.jobs.status({ scope, jobId: job.jobId });
if (state.status === 'complete') {
  const page = await eye.analytics.jobs.page({ scope, jobId: job.jobId, limit: 100 });
  // page.result.kind로 응답 타입을 좁힌다. nextOffset은 같은 저장 결과의 다음 페이지다.
}
```

등록은 SQL 완료를 기다리지 않는다. 실행 중 같은 사이트·scope·조회 종류·정규화 조건의 요청은 하나의 작업을 공유한다. 객체 키 순서와 생략된 기본 limit은 정규화하지만 배열 순서는 유지한다. 새로고침마다 from/to를 바꾸면 서로 다른 조회이므로, 위 예처럼 화면이 표시할 기준 구간을 고정한다. 완료 결과는 15분 동안 새 등록에도 재사용하고, 일반 작업과 결과는 등록 후 1시간 보관한다. 자동 보고서에 연결된 작업은 아래의 더 긴 보관 기한을 쓴다. `freshUntil` 이후에는 새 등록이 새 작업을 만들지만 기존 ID의 페이지는 `expiresAt`까지 읽을 수 있다.

`scope`는 인증 기능이 아니라 캐시 격리 키다. 호스트가 인증된 권한 집합과 정책 버전에 따라 공급하고, 실제 조회 조건도 권한에 맞게 제한해야 한다. 브라우저가 임의 scope나 다른 사용자의 job ID로 조회하도록 공개하지 않는다. 같은 job ID라도 다른 사이트·scope에서는 상태와 결과가 `not_found`다. 권한이 변경되면 scope도 바꾼다.

결과의 `meta.queriedAt`/`receivedBefore`, 보상 기준, `truncated`는 원래 계산 당시 값을 유지한다. `completedAt`은 작업 완료 시각이며 데이터 수신 watermark가 아니다. 페이지 이동은 R2의 같은 결과를 읽고 원본 SQL을 다시 실행하지 않는다. 페이지 크기를 늘려도 원래 조회 limit을 넘어 복구하지 않으며, 잘린 집계는 조건을 좁혀 새 작업으로 등록한다. timeline의 `nextCursor`는 기존 원본 조회 계약이고 작업의 `nextOffset`과 다르다.

사이트당 미완료 작업 8개, 보관 작업 256개, 작업 결과 16 MiB로 제한한다. 초과 등록은 `unavailable`이며 호스트가 기존 작업을 기다린 후 재시도한다. alarm은 사이트당 한 작업씩 처리하므로 동시 SQL 실행은 한 개다. 일반 오류는 1분/5분 대기 후 최대 3회 시도하고 잘못된 쿼리는 즉시 실패한다. 실패·취소 작업을 다시 등록하면 새 ID를 만든다. `cancel`은 같은 scope에서 공유하는 작업 전체에 적용되며 이미 실행된 SQL의 과금을 되돌리지는 않는다. API 오류 문자열에는 원격 SQL이나 자격 증명을 포함하지 않는다.

`queued → running → complete/failed` 상태가 저장되며 객체가 재시작되어도 복구한다. R2에 결과를 쓴 뒤 상태 게시 전에 중단되면 같은 결과를 재사용한다. 취소·완료 결과의 물리 삭제는 만료 후 alarm이 처리하므로 장애 중 지연될 수 있다. 논리 만료 후에는 조회할 수 없다. `eye/reports/` prefix에 최소 3일의 lifecycle을 추가하면 비정상 종료로 남은 객체도 정리할 수 있다. 학습의 `eye/cohorts/`와는 별도로 설정한다.

자동 보고서를 활성화하기 전에 기존 `eye/reports/` 만료 규칙도 최소 3일로 늘린다. 최대 49시간의 논리 보관 기한보다 먼저 R2 객체를 삭제하면 상태가 complete여도 결과를 읽지 못한다.

## 기본 보고서 자동 생성

`learning({ from, to, experimentId?, limit? })`은 저장된 complete 관측만 집계한다. 원본 골·신원·노출을 다시 읽지 않는다. 실험·arm·학습 세대·관측 기간별 `completed`, `learningValue`, `meanValue`, `latestReceivedAt`을 반환한다. 보상 없는 완료 표본도 분모에 포함한다. `rewardBasis: 'closed_learning'`, `cohortBasis: 'observation_start'`이며, 학습 반감기로 계속 변하는 정책 점수·정책 평균과는 다르다. 원본 귀속·속성별 탐색에는 기존 `arms()`를 쓴다.

자주 쓰는 골 합계나 학습 요약은 서버에서 한 번 등록한다. 화면 조회마다 등록할 필요는 없다.

```ts
const ref = { scope: 'staff:analytics:v1', scheduleId: 'learning-overview' };
await eye.analytics.jobs.schedule({
  ...ref, report: { kind: 'learning' }, // 또는 { kind: 'goals' }
  windowMs: 28 * 86_400_000, intervalMs: 3_600_000,
});
// 화면 조회: 실행을 시작하지 않고 최근 저장 결과를 찾는다.
const schedule = await eye.analytics.jobs.scheduled(ref);
if (schedule.latestJob) {
  const page = await eye.analytics.jobs.page({ ...ref, jobId: schedule.latestJob.jobId });
  // page.request.query.from/to: 결과의 실제 조회 기간
  // page.result.data.meta: 수신 시각 상한·조회 시각·truncated
}
// 더 이상 필요 없을 때: await eye.analytics.jobs.unschedule(ref);
```

등록은 opt-in이고 사이트당 최대 32개다. 기본 보고서는 `learning`(선택적 experimentId)과 `goals`만 허용하며 임의 속성 조합을 자동으로 생성하지 않는다. 간격은 기본 1시간, 1~24시간이고 최근 조회 구간은 1시간~59일이다. 60일 원본 범위 안에서 대기·재시도할 여유를 둔다. 일반 ad hoc API는 여전히 60일을 지원한다. 자동 보고서는 최대 1000행이며 `meta.truncated`가 참이면 실험이나 기간을 좁힌다.

같은 scope·ID·설정은 재등록해도 중복 실행하지 않는다. 설정을 바꾸면 이전 결과 연결을 지우고 새 조건으로 실행한다. 누락된 실행을 소급 반복하지 않고 실제 실행 시각 기준으로 구간을 정한다. `nextAt`은 다음 등록 예정 시각이며 완료·데이터 수집 보장 시각이 아니다. SQL은 기존 작업과 같은 대기열을 사용하고, 등록 용량이 부족하면 1분 후 재시도한다. 사용자 선택이나 학습 실행을 유발하지 않는다.

`currentJob`은 최신 시도, `latestJob`은 보관 중인 마지막 완료 결과다. 새 실행이 실패해도 이전 결과를 보여줄 수 있으며 `completedAt`, `page.request.query`, `error`를 함께 표시한다. 결과 보관은 생성 당시 간격 × 2 + 1시간(3~49시간)이며 연속 실패로 이전 결과가 만료되면 `latestJob`은 null이다. `freshUntil`의 15분은 동일 쿼리 등록 캐시 기한이며 자동 보고서의 실행 간격과 별개다. `unschedule`은 향후 실행만 중단하고 이미 등록된 공유 작업·결과는 자체 만료까지 유지한다.

ReportObject의 SQLite 테이블은 최초 사용 시 추가하며 새 binding이나 DO migration은 필요 없다. scope별 격리는 일반 작업과 동일하다. 자동 보고서가 읽는 전체 사이트 또는 선택한 실험에 대한 권한을 호스트가 확인해야 한다.

## 공통 규칙

`from`, `to`는 최근 60일 안의 Unix 밀리초이며 `[from, to)`다. 기본 `limit=100`, 최대 1,000행이다. 한 행을 추가로 조회해 `meta.truncated`를 표시한다. 집계가 잘리면 arm·세대·속성·기간 조건을 좁힌다. 쿼리는 30초, 응답은 16 MiB로 제한하며 초과를 빈 성공 결과로 바꾸지 않는다.

모든 테이블은 site별 record ID의 최신 revision을 선택한 뒤 상태·속성 조건을 적용한다. 같은 revision의 재전송은 최초 수신 행을 사용한다. 원본 goal 재전송은 한 번만 세며 credit을 사이트 합계에 다시 더하지 않는다.

`meta`에는 `queriedAt`, `receivedBefore`, `consistency: 'eventual'`, `truncated`, `bytesScanned`가 있다. `receivedBefore`는 처리 시각 상한이지 수신 완료 watermark가 아니다. 행별 `latestReceivedAt`도 관측한 최댓값일 뿐이다. 파일 반영 지연과 테이블 간 반영 차이로 최근 결과가 바뀔 수 있다. 현재 정책 상태는 별도의 `experiments.policy()`에서 읽는다. 정책 응답의 `meanReward`는 원래 가치 단위이며 `score`는 공통 `scoreScale`로 나눈 비교용 점수다. 현재 정책의 asOf는 통계를 감쇠해 평가한 기준 시각이다. statsAsOf는 마지막 적용한 마감 통계의 기준이다.

원본 subject는 입력 당시 cid·uid를 보존한다. 로그인 이력으로 익명 구간의 첫 uid를 조회 시 연결하며 영구 상태 인계를 하지 않는다. 수집 원본과 신원 projection은 같은 Stream 경로로 보내지만 테이블 간 가시성 시각은 다를 수 있다. pending 관측과 selected 배정은 보관된 노출 원본에서 조회 시 재구성한다. 첫 전송을 잃어도 후속 노출로 복구할 수 있으며, 학습이 확정한 관측 결과는 별도로 저장한다. 기존 물리 projection도 함께 읽되 ID별 한 행만 반환한다.

## Arm 비교

`arms({ experimentId, from, to, armId?, generation?, goalId?, groupBy?, filter?, hasEvent?, limit? })`

cohort 기간은 관측 시작 시각이며 속성은 최초 실제 노출에서 고정한다. arm·학습 세대·관측 기간은 항상 분리하고, 속성 그룹을 최대 3개 추가한다. `rows`는 `armId`, `generation`, `observationWindowMs`, `groups`, `completed`, `pending`, `interrupted`, `subjects`, `totalValue`, `learningValue`, `meanValue`, `latestReceivedAt`를 반환한다. `cohortBasis`는 `observation_start`다.

`subjects`는 관측에 기록된 고유 신원 키 수다. 같은 사람의 cid/uid 전환이나 다른 쿠키를 하나로 합친 인원수가 아니며 관측 수와도 다르다.

평균의 분모는 모든 완료 관측이다. `goalId`를 지정해도 분자만 선택할 뿐 달성하지 않은 완료 관측을 분모에서 빼지 않는다. pending·interrupted를 0 보상 완료로 바꾸지 않으며 완료가 없으면 평균은 null이다. 관측 밖의 credit은 평균에 포함하지 않고 타임라인의 `outside_observation`으로 확인한다.

`hasEvent: { name, filter? }`는 같은 uid 또는 첫 로그인으로 연결되는 익명 구간의 관측 구간 안에 발생한 track 이벤트 존재 조건이다. 여러 이벤트가 있어도 관측 수는 늘어나지 않으며 첫 로그인 전후에도 연결된다. 이 사후 분류는 배정이나 학습 목표를 바꾸지 않는다.

집계가 유한한 double로 표현되지 않으면 `numeric_range` 오류를 반환하며 clipping하지 않는다. MAB 배정 확률은 시점에 따라 바뀌므로 이 평균을 인과적 효과나 p-value로 제공하지 않는다.

## 필터와 속성값

필드는 `{ key, type: 'string' | 'number' | 'boolean' }`이다. 키는 JSON 경로가 아닌 최상위 키 하나다. `eq/ne/in`, 숫자의 `lt/lte/gt/gte`, `exists/missing`을 `and/or/not`으로 조합한다. 문자열 `"3"`을 숫자 3으로 변환하지 않는다. 입력 값과 필드 선언 타입이 다르면 오류다.

`eq: null`은 키가 존재하고 명시적으로 null인 값에 일치한다. 없는 키는 `missing`으로 선택한다. `ne`는 eq의 부정이므로 없는 키·다른 타입도 포함할 수 있다. 그룹과 속성값 조회에서는 없는 키·null·다른 타입이 null 그룹으로 합쳐진다. 필터는 최대 64개 노드·깊이 8, `in`은 최대 100개 값이다.

`attributeValues({ from, to, field, filter?, limit? })`는 원본 이벤트 속성의 값별 빈도다. `attributeKeys({ from, to, limit? })`는 수집된 키·타입·출처(event/user) 목록을 제공한다. 같은 키의 여러 타입과 명시적 null을 구분하며 누락된 키를 추정하지 않는다. 요청 구간에 걸친 UTC 날짜 전체에서 키를 탐색하며 응답의 coverage가 실제 날짜 범위와 basis=utc_day를 명시한다. 좁은 시간 구간보다 넓은 날짜의 키가 포함될 수 있고, 발생 횟수나 정확한 시각 필터는 제공하지 않는다. 요청 자체는 최근 60일 제한을 지키지만 경계 날짜의 사전 메타데이터는 날짜 전체를 읽는다.

## Goal과 시계열

`goals({ from, to, goalId?, filter?, limit? })`는 발생 시각 기준 accepted 원본 goal의 `goalId`, `events`, `totalValue`, `latestReceivedAt`를 반환한다. 중지·삭제 때문에 무시된 goal은 합계에 넣지 않는다. 음수 goal은 독립적인 음수 값이다.

`series({ ...goalQuery, bucketMs })`는 같은 값에 `bucketStart`를 추가한다. bucket은 Unix epoch 기준 UTC 경계다. 이벤트가 없는 bucket은 자동으로 0 행을 만들지 않는다.

## 타임라인

`timeline({ from, to, subject: { cid } | { uid }, includeLinked?, cursor?, limit? })`

다섯 테이블의 최신 레코드를 `(occurredAt, table, recordId)` 순으로 반환한다. 원본 `attributes`, `payload`에서 선택 확률·정책 버전·귀속 사유·동시 실험 노출도 탐색할 수 있다.

cid 조회는 해당 브라우저 이력이다. uid 조회는 해당 uid 행을 포함하며 기본 includeLinked=true이면 보존 범위 내 첫 로그인 직전 익명 구간도 포함한다. 로그아웃·다른 계정은 경계다. 원본 cid·uid를 수정하거나 서로 다른 계정을 병합하지 않는다. 링크 이력 자체가 보존 범위 밖이면 연결을 복구하지 않는다.

`nextCursor`는 같은 조건의 다음 요청에 전달한다. 수신 시각 상한과 정렬 키를 고정하지만 Iceberg snapshot을 고정하지 않는다. 늦게 가시화된 행은 이전 페이지 범위에도 나타날 수 있다. 엄밀한 전체 스냅샷 export나 실시간 tail을 보장하지 않는다.

## 외부 검증 범위

60일 조회 제한은 물리 삭제 정책이 아니다. 이전 데이터 정책은 합의대로 보류하며 R2에 자동 삭제 규칙을 설치하지 않는다.

현재 SQL 의미는 SQLite에 Basin JSON 함수 계약을 적용해 검사하며 HTTP 경계도 검사한다. 실제 Basin planner·타입 반환·예산 제한·6천만 행 지연은 원격 검증이 필요하다. 기준 문서는 [조회 API](https://developers.cloudflare.com/basin-sql/query-data/), [지원 SQL과 제한](https://developers.cloudflare.com/basin-sql/reference/limitations-best-practices/), [JSON 함수](https://developers.cloudflare.com/basin-sql/sql-reference/scalar-functions/#json-functions)다.

## 확정 학습과 원본 분석

학습은 Queue 배치 안에서만 정렬해 보상을 누적하고 관측 종료+유예 이후 한 번 마감한다. 고정 SQLite outbox로 재시도하며 뒤늦은 사건은 학습을 다시 쓰지 않는다. 전역 순서를 복원하지 않으므로 배치 사이 순서 역전과 늦은 신원 연결은 원본 재귀속과 다른 결과를 만들 수 있다. 학습은 별도 credit 행을 전송하지 않고 observations의 complete 행에 최종 보상을 저장한다. arms의 rewardBasis는 raw_attribution이다. totalValue/meanValue는 현재 조회 가능한 원본을 다시 귀속한 값이고 learningValue는 마감 때 확정한 전체 골 보상이다. goalId 필터는 원본 귀속 분자에만 적용하며 learningValue는 전체 골 기준을 유지한다. 학습 정책에는 학습 반감기도 적용되므로 단순 학습 합계와 정책 평균 역시 다르다.

타임라인의 live credits는 learningClosed=false이며 학습 반영 확인서가 아니다. eligible은 관측 구간상 자격을 뜻한다. outside_observation 귀속은 분석에서 보이지만 학습에 들어가지 않는다. 원본 사이트 goal 합계는 한 번만 센다.

## 시간별 arm 성과·트래픽·정책

- `armSeries({ ...armQuery, bucketMs })`: 관측 시작 시각의 bucket별 `arms()` 결과다. goal별 0 분모·속성 필터·groupBy 계약을 그대로 유지한다.
- `traffic({ experimentId, from, to, bucketMs, limit? })`: bucket·arm·generation별 `assignments`, `exposures`, `assignmentShare`, `exposureShare`다. assignments는 실제 노출된 assignment ID만 한 번 센다. 선택만 하고 노출하지 않은 배정은 저장하지 않는다. 노출은 실제 exposure 이벤트다. 비율의 분모는 같은 bucket·generation 전체 arm이며 0이면 null이다. 확률과 실제 노출 비율은 다르다.
- `policies({ experimentId, from, to, armId?, limit? })`: 발행 시점별 arm 선택 확률·감쇠 평균·score·scoreScale·status·generation을 반환한다. 비활성 arm은 확률 0, 평균·점수 null이다. 이것은 최대 분당 한 번 생성하는 발행본 이력이며 모든 로컬 선택 순간의 통계 변화 이력은 아니다. 실제 신규 배정의 선택 확률은 decision payload에 보존한다. 정책 요청이 없던 기간을 보간하지 않는다. 결과가 잘리면 기간·arm 조건을 좁힌다.

신규 설치는 일곱 sink를 만든다. 기존 v1 설치의 전환은 [배포 호환성](../TECHNICAL_DESIGN.md#배포-호환성)을 따른다.

## 사용자군 비교와 페이지 처리 예제

아래 eye는 같은 siteId의 서버 클라이언트다. 속성 이름은 사이트에서 실제 수집한 값으로 바꾼다.

```ts
const to = Date.now(), from = to - 7 * 86_400_000;
const report = await eye.analytics.arms({
  experimentId: 'checkout', from, to,
  groupBy: [{ key: 'device', type: 'string' }],
  filter: { field: { key: 'locale', type: 'string' }, op: 'eq', value: 'ko' },
  hasEvent: {
    name: 'page_view',
    filter: { field: { key: 'path', type: 'string' }, op: 'eq', value: '/checkout' },
  },
});
// report.rows[i].groups[0]은 요청한 device 그룹 값이다.
// 완료 관측이 없으면 meanValue는 null이며, meta.truncated이면 조건을 좁힌다.

const first = await eye.analytics.timeline({ from, to, subject: { uid: 'user-123' } });
if (first.nextCursor) {
  const next = await eye.analytics.timeline({
    from, to, subject: { uid: 'user-123' }, cursor: first.nextCursor,
  });
}
```

위 `filter/groupBy`는 첫 expose의 userAttributes, `hasEvent.filter`는 track의 attributes를 검사한다. `attributeValues`는 원본 사건 속성 빈도이므로 같은 키라도 관측 사용자군의 빈도와 일치할 필요가 없다. 상세 필드 타입은 [생성 레퍼런스](api/types.md#filter)를 따른다.

### projection 전송 축소 버전으로 전환

추가 테이블이나 DO migration은 없다. 새 조회 코드는 기존 pending·selected 행과 새 원본을 함께 읽으며 complete 학습 결과가 pending보다 우선한다. 새 원본만 있는 표본은 발생 시각·event ID 순으로 최초 노출의 속성을 고른다. 기존 projection과 겹치면 기존 조회처럼 먼저 수신한 행을 우선해 전환 중 속성을 보존한다.

조회 코드와 Queue consumer를 함께 업데이트한다. 이전 조회 코드로 되돌리면 새로 수집한 표본의 pending·배정 내역을 읽지 못한다. 롤백 시 이 조회 호환 코드는 유지해야 한다. 기존 observations·decisions 테이블은 삭제하지 않는다. 운영자 조회는 원본을 추가로 읽으므로 비동기 작업·결과 캐시 사용을 권장한다. 사용자 선택 경로는 바뀌지 않는다.
