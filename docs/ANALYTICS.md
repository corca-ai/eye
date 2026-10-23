# 분석 API 계약

[연동 가이드](INTEGRATION.md) · [API 시그니처](api/client.md#eyeanalyticsarms) · [응답 타입](api/types.md#armreport) · [문서 안내](README.md)

`createEye(...).analytics`는 서버 Service Binding을 통해 고객 계정의 Basin SQL을 호출한다. 토큰은 Eye Worker secret에만 둔다. UI와 공개 HTTP API는 호스트가 구성한다.

## 공통 규칙

`from`, `to`는 최근 60일 안의 Unix 밀리초이며 `[from, to)`다. 기본 `limit=100`, 최대 1,000행이다. 한 행을 추가로 조회해 `meta.truncated`를 표시한다. 집계가 잘리면 arm·세대·속성·기간 조건을 좁힌다. 쿼리는 30초, 응답은 16 MiB로 제한하며 초과를 빈 성공 결과로 바꾸지 않는다.

모든 테이블은 site별 record ID의 최신 revision을 선택한 뒤 상태·속성 조건을 적용한다. complete를 먼저 걸러 이후 interrupted 정정을 놓치지 않는다. 원본 goal 재전송은 한 번만 세며 credit을 사이트 합계에 다시 더하지 않는다.

`meta`에는 `queriedAt`, `receivedBefore`, `consistency: 'eventual'`, `truncated`, `bytesScanned`가 있다. `receivedBefore`는 처리 시각 상한이지 수신 완료 watermark가 아니다. 행별 `latestReceivedAt`도 관측한 최댓값일 뿐이다. 파일 반영 지연과 테이블 간 반영 차이로 최근 결과가 바뀔 수 있다. 현재 정책 상태는 별도의 `experiments.policy()`에서 읽는다. 정책 응답의 `meanReward`는 원래 가치 단위이며 `score`는 공통 `scoreScale`로 나눈 비교용 점수다. 현재 정책의 `asOf`는 모든 보유 shard를 비교한 공통 시각으로, 내부 DO 시각 차이 때문에 응답자의 벽시계보다 앞설 수 있다. 예약 만료는 실제 coordinator 시각을 사용한다.

일반 `track`의 `subject_key`는 공급된 cid·uid 기준이며 원본 신원을 보존한다. 로그인 인계 전후의 관측 연결은 `subject_key`의 일치가 아니라 물리 상태 위치인 `state_key`를 사용한다. 일반 로그는 Queue→Stream으로 직접 전송하고 학습 자료는 Subject outbox를 거치므로 테이블 간 가시성 시각은 다를 수 있다.

## Arm 비교

`arms({ experimentId, from, to, armId?, generation?, goalId?, groupBy?, filter?, hasEvent?, limit? })`

cohort 기간은 관측 시작 시각이며 속성은 최초 실제 노출에서 고정한다. arm·학습 세대·관측 기간은 항상 분리하고, 속성 그룹을 최대 3개 추가한다. `rows`는 `armId`, `generation`, `observationWindowMs`, `groups`, `completed`, `pending`, `interrupted`, `subjects`, `totalValue`, `meanValue`, `latestReceivedAt`를 반환한다. `cohortBasis`는 `observation_start`다.

`subjects`는 cohort 전체의 고유 상태 소유자 수다. 익명 상태를 uid가 인계받아도 같은 상태를 두 번 세지 않는다. 쿠키를 재설정한 익명 사용자가 같은 사람인지는 추정하지 않는다. 관측 수와 고유 사용자 수는 다르다.

평균의 분모는 모든 완료 관측이다. `goalId`를 지정해도 분자만 선택할 뿐 달성하지 않은 완료 관측을 분모에서 빼지 않는다. pending·interrupted를 0 보상 완료로 바꾸지 않으며 완료가 없으면 평균은 null이다. 관측 밖의 credit은 평균에 포함하지 않고 타임라인의 `outside_observation`으로 확인한다.

`hasEvent: { name, filter? }`는 같은 상태 소유자의 관측 구간 안에 발생한 track 이벤트 존재 조건이다. 여러 이벤트가 있어도 관측 수는 늘어나지 않으며 cid→uid 인계 전후에도 연결된다. 이 사후 분류는 배정이나 학습 목표를 바꾸지 않는다.

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

cid 조회는 해당 브라우저 이력이다. uid 조회는 그 uid가 기록된 행을 포함하며, 기본 `includeLinked=true`이면 확인된 로그인 구간 안의 익명 행도 합친다. 로그인 전의 모든 과거 이력이나 로그아웃 후 익명 이력을 추정해서 붙이지 않는다. 연결 구간은 최신 revision으로 정정하며 다른 uid가 명시된 행은 덮어쓰지 않는다. 원본 cid·uid는 수신된 이벤트 값으로 보존한다.

`nextCursor`는 같은 조건의 다음 요청에 전달한다. 수신 시각 상한과 정렬 키를 고정하지만 Iceberg snapshot을 고정하지 않는다. 늦게 가시화된 행은 이전 페이지 범위에도 나타날 수 있다. 엄밀한 전체 스냅샷 export나 실시간 tail을 보장하지 않는다.

## 외부 검증 범위

60일 조회 제한은 물리 삭제 정책이 아니다. 이전 데이터 정책은 합의대로 보류하며 R2에 자동 삭제 규칙을 설치하지 않는다.

현재 SQL 의미는 SQLite에 Basin JSON 함수 계약을 적용해 검사하며 HTTP 경계도 검사한다. 실제 Basin planner·타입 반환·예산 제한·6천만 행 지연은 원격 검증이 필요하다. 기준 문서는 [조회 API](https://developers.cloudflare.com/basin-sql/query-data/), [지원 SQL과 제한](https://developers.cloudflare.com/basin-sql/reference/limitations-best-practices/), [JSON 함수](https://developers.cloudflare.com/basin-sql/sql-reference/scalar-functions/#json-functions)다.

## 학습 정정 마감과 분석 값

`correctionWindowMs`가 지난 관측은 학습 reward와 경계를 고정한다. 원본 사건 및 분석 credit은 계속 기록하며, credit payload의 `learningClosed`는 계산 시 해당 학습 정정 기한이 지났음을 표시한다. `learningEligible`와 `status=eligible`은 관측 구간·배정에 따른 귀속 가능성이지 기한 후 보상까지 학습했다는 보장이 아니다. 따라서 관측 reward에 기반한 전체 arm 결과와 최신 credit에 기반한 goal별 탐색 결과는 기한 이후 서로 다를 수 있다. 원본 사이트 goal 합계는 영향을 받지 않는다. 정정 기한이 지나 처음 발견한 과거 관측은 `interrupted`/`correction_expired`로 표시한다.

진행 중 보상의 shard 전달은 생략하지만 분석용 관측의 최신 상태는 계속 내보낸다. 한 처리 묶음 안의 내부 중간 revision은 생략될 수 있다. 새 노출의 로컬 중복 테이블을 제거한 것은 분석 저장소의 원본 events 삭제가 아니다.

## 시간별 arm 성과·트래픽·정책

- `armSeries({ ...armQuery, bucketMs })`: 관측 시작 시각의 bucket별 `arms()` 결과다. goal별 0 분모·속성 필터·groupBy 계약을 그대로 유지한다.
- `traffic({ experimentId, from, to, bucketMs, limit? })`: bucket·arm·generation별 `assignments`, `exposures`, `assignmentShare`, `exposureShare`다. assignments는 신규 selected 결정만 세고 held·인계 결정은 새 무작위 배정으로 세지 않는다. 노출은 실제 exposure 이벤트다. 비율의 분모는 같은 bucket·generation 전체 arm이며 0이면 null이다. 확률과 실제 노출 비율은 다르다.
- `policies({ experimentId, from, to, armId?, limit? })`: 발행 시점별 arm 선택 확률·감쇠 평균·score·scoreScale·status·generation을 반환한다. 비활성 arm은 확률 0, 평균·점수 null이다. 이것은 최대 분당 한 번 생성하는 발행본 이력이며 모든 중앙 선택 순간의 통계 변화 이력은 아니다. 실제 신규 배정의 선택 확률은 decision payload에 보존한다. 정책 요청이 없던 기간을 보간하지 않는다. 결과가 잘리면 기간·arm 조건을 좁힌다.

`policies`, `attribute_keys` 두 분석 테이블을 추가했다. 신규 설치는 일곱 sink를 만든다. 기존 설치는 같은 공통 스키마의 두 테이블/sink와 fanout 분기를 추가해야 한다. 기존 다섯 테이블은 유지한다. 실제 계정의 스키마·pipeline migration을 자동 실행하지 않는다.

신원 인계 시 `identity_links`에 source/target state 연결을 기록한다. arm 집계는 연결된 상태 소유자를 중복 계산하지 않으며 `hasEvent`는 연결 시점 이후의 다른 상태 이벤트만 이어 붙인다. 로그인 이전의 서로 다른 기기 이벤트를 소급 연결하지 않는다.

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
