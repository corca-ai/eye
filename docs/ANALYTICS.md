# 실험 및 골 집계

[연동 가이드](INTEGRATION.md) · [API 시그니처](api/client.md) · [응답 타입](api/types.md)

Eye는 실험 정책·성과와 서비스 목표의 합계를 SiteControl SQLite에서 읽는다.
호스트는 운영자 권한과 화면을 관리한다.

## Automatic finalized goal hours

`eye.analytics.summaries.hours()` returns `coverageFrom`, `finalizedBefore` and
`queriedAt`. Collection is automatic for every accepted registered goal and
starts at the first whole UTC hour after the runtime initializes the store.
There is no configuration or historical backfill. Existing optional summaries
below retain their separate occurrence/start-time semantics.

`eye.analytics.summaries.series({ from, to, goalId? })` reads all goals in one
call, or one goal when filtered. It returns hourly `bucketStart`, `goalId`,
`events` and signed `totalValue`, with `meta.basis: 'receipt_hour'`.
Bounds must be whole UTC hours, within coverage and at most 59 days apart.
Empty buckets are omitted; more than 50,000 result rows fails with `unavailable`,
so narrow the range or specify `goalId`.
Only finalized hours are readable. At 14:10, the 13:00–14:00 bucket becomes
immutable and readable directly from SQLite.

Eye stamps first receipt on the server. External occurrence must precede receipt
by at most 15 seconds; caller-supplied receipt times cannot extend admission.
Queue retries retain that receipt. Accepted goals update their receipt-hour
bucket in the same transaction as deduplication. Work processed after the
bucket's ten-minute closing deadline is omitted from that aggregate permanently. Unregistered/inactive goals do not count.
Coverage starts at rollout. Hourly rows expire after 60 days, with bounded background cleanup.

Experiment learning preserves occurrence-time attribution and closes at
observation end plus a fixed one minute. This grace is not a setting. Delayed
internal processing can miss that deadline; closed rewards are never reopened.

## 선택적 요약

자주 조회하는 기본 합계는 `analytics.summaries.configure()`로 별도로 활성화하고 `query()`로 읽는다. 자동 시간별 `hours()/series()`는 이 설정과 독립적이다. 호스트가 인증한 관리자만 설정하고, 조회 역시 해당 사이트·goal·실험 권한을 확인한다.

```ts
// 관리 경로에서 한 번 설정. 같은 목록의 재호출은 집계를 지우지 않는다.
await eye.analytics.summaries.configure({ goalIds: ['purchase'], experimentIds: ['checkout'] });
const status = await eye.analytics.summaries.status();
const hour = 3_600_000, to = Math.floor(Date.now() / hour) * hour;
const from = to - 24 * hour;
if (status.state === 'collecting' && status.coverageFrom !== null && from >= status.coverageFrom) {
  const report = await eye.analytics.summaries.query({ kind: 'learning', experimentId: 'checkout', from, to });
  // rows: armId, generation, observationWindowMs, count, total, mean
  // goal: { kind: 'goals', goalId: 'purchase', from, to }
}
```

UTC 전체 시간 경계의 `[from,to)`만 허용하며 최대 59일, 끝은 현재 시간의 시작 이하이다. goal은 발생 시각, learning은 관측 시작 시각으로 선택한다. `coverageFrom`은 설정한 이후 첫 전체 시간과 최근 60일 보존 경계 중 늦은 쪽이다. 과거 데이터는 소급 집계하지 않는다. 전 구간 coverage가 없거나 ID가 미설정이면 `unavailable`이며 0 합계로 대신하지 않는다. 집계가 있는 범위의 사건 없는 결과는 빈 rows다.

`meta.basis='durable_local'`은 내부에서 수락한 goal/완료한 관측 기준이다. `queriedAt`은 읽은 시각이며 원래 수신 시각이나 수집 완료 watermark가 아니다. 늦은 goal 또는 후속 마감으로 과거 시간의 값이 바뀔 수 있다. learning은 policy/default 모두와 0 보상 표본을 count에 넣고 arm·세대·관측 기간별로 나누며, 평균은 표본 합계/count다. 버킷 평균을 단순 평균하지 않는다. 최종 합계/평균을 표현할 수 없으면 `numeric_range`이며 학습 수집은 계속된다.

설정 ID는 goal·실험 합계 최대 32개, 저장은 사이트당 최대 50,000 버킷 행이다. 설정 목록 변경은 전체 요약을 초기화하므로 필요한 ID를 한 번에 등록한다. 한도에 도달하면 지연된 만료 정리를 최대 1,000행 먼저 수행한다. 그래도 새 버킷을 만들 수 없으면 `capacity_exceeded`로 요약 수집·조회를 중단하며 실험 학습은 계속한다. 빈 목록으로 비활성화한 뒤 다시 설정하면 새 coverage로 시작한다. 추가 SQLite 쓰기 비용이 있으므로 자주 쓰는 요약부터 선택한다.

## 일상 실험 대시보드

`analytics.summaries.dashboard({experimentId, boundaries})`는 SiteControl SQLite의
영속 집계를 읽는다.
골은 수락·중복 제거·신원 연결·실험별 마지막 노출·가치 분배·감쇠를 학습과 같은
트랜잭션에서 처리할 때 반영한다. 진행 중인 관측도 즉시 포함하며, 관측 창 밖이나
실제 처리 시 마감된 표본의 골은 제외한다. 완료 학습 수치는 별도로 제공한다.
배치 사이의 순서 역전은 학습과 같이 소급 정정하지 않는다.

`coverageFrom` 이전은 미수집이며 0이 아니다. 설치 후 첫 완전한 분부터 시작한다.
`lastProcessedAt`은 마지막 처리 시각이지 수신 완료 watermark가 아니다.
진단 카운터는 설치 이후 사이트 전체의 누계이며 실험별 오차율로 해석하지 않는다.
분 단위 저장을 브라우저 로컬 자정 경계로 합칠 수 있도록 오름차순 `boundaries`를
받는다. 모든 경계는 완료된 분이며 최대 59일/256구간이다. 정책의 원래 발행 시각은
보존한다. 결과 50,000셀·정책 5,000회 상한을 넘으면 명시적으로 실패한다.
집계 버킷은 500,000행 상한으로 오래된 구간을 제거하고 coverage를 전진시킨다.
집계·중복 방지 키·정책 이력은 60일 보존하고 alarm에서 제한된 페이지로 정리한다.

로그인 호스트는 같은 CID로 `identify`한 뒤 가입 골을 전달해야 한다.
`anonymous`는 현재 로그아웃 상태를 확인하되 이미 익명이면 기존 노출 연결을 유지한다.
`logout`은 의도적으로 익명 구간을 끊는 별도 사건이다. 계정 전환 시 이전 계정의
노출을 다른 UID로 넘기지 않으며 초기 익명 확인과 실제 로그아웃을 혼동하지 않는다.
