# 원본 분석의 조회 구조 개선

기준 `af6f7a8`. 수집량·보상 수학·분석 API는 유지하고 원본 조회의 입력과 조인 구조를 바꾼다.

## 변경과 정확성 조건

관측·배정 재구성은 원본 노출을 조회 구간의 시작부터 읽는다. 관측 시작 또는 배정 시각이 from 이상이면 해당 노출도 from 이상이기 때문이다. to 뒤의 노출은 유지한다. 실제 첫 노출이 배정 뒤에 늦게 발생할 수 있어 이를 to로 자르면 안 된다. 완료 관측과의 병합, 최초 노출 속성 선택, receivedBefore와 보관 기간 기준을 적용한다.

골 귀속 후보는 명시적 uid, 첫 로그인으로 연결된 익명 구간, 익명 cid의 세 가지 상호 배타적인 소유권 경로로 구성한다. 각 경로에 동등 조인 키를 노출해 전체 골과 노출을 시간 조건으로 먼저 연결하는 구조를 피한다. 경로를 합친 후에 실험별 최신 노출을 선택하고, 귀속 기간 검사 → 실험 수 분할 → 관측 적격성 검사 순서를 유지한다. 대상 실험으로 먼저 거르지 않으므로 경쟁 실험의 분모가 보존된다.

UNION은 각 경로의 골/노출 ID가 유일하고 경로가 배타적이므로 UNION ALL과 같은 후보를 만든다. 기존 원격 기록에서 확인된 Basin의 분산 UNION ALL 문제를 피해 사용한다. 골·로그인 이력과 경쟁 실험 노출의 전체 문맥은 유지하며, 모든 조회를 무조건 from/to로 제한하는 최적화는 아니다.

## 검증과 측정

비교 기준인 귀속 SQL은 `benchmarks/analytics/reference-attribution.ts`에 고정했다. 현재 SQL과 같은 원본 스냅샷에서 모든 credit 열을 비교한다. pending 관측·배정은 현재 분석 통합 검사에서 검증한다. 명시적 uid·익명 cid·첫 로그인·로그아웃/재로그인·다른 기기·동일 시각 ID 순서·재전송·긴/짧은 귀속 기간·음수 골·경쟁 실험·반복 노출 속성을 포함한다. 기존 분석 통합 검사도 함께 실행한다.

[측정 결과](measurements/query-structure-results.json)는 Node.js SQLite와 JSON UDF 어댑터를 사용한 로컬 계산 시간이다. 방문마다 노출·경쟁 실험·구매/환불과 20개의 일반 행동 로그를 생성했다. 최초 비교에서 credit 전체가 같은지 확인하고, 워밍업 후 3회 중앙값을 사용한다.

| 사용자 수 | 원본 행 | credit 수 | 이전 ms | 이후 ms |
| ---: | ---: | ---: | ---: | ---: |
| 25 | 775 | 77 | 46.70 | 54.50 |
| 75 | 2331 | 232 | 1634.10 | 471.67 |

작은 입력에서는 분기·UNION의 고정 비용이 있다. 큰 입력에서 후보 조합 감소 효과가 나타났다. SQLite의 조인 실행은 Basin의 실제 계획·파일 스캔량·과금과 다르므로 이 비율을 원격 성능·비용 절감률로 사용하지 않는다. 배포 환경에서 EXPLAIN과 bytesScanned, 실제 응답 시간을 추가 확인한다.

저장소 체크아웃에서 재현한다. [측정 코드](https://github.com/corca-ai/eye/blob/main/benchmarks/analytics/query.ts)와 기준 SQL은 제품 패키지에 포함하지 않는다.

```sh
npm ci
node_modules/.bin/esbuild benchmarks/analytics/query.ts --bundle --platform=node --format=esm --outfile=/tmp/eye-analytics-query.mjs
node /tmp/eye-analytics-query.mjs
npm run check
npm run check:package
```

## 최신 노출 구간과 타임라인 범위 축소

기준 `9db4e79` 이후 명시적 uid의 노출을 `(uid, experiment_id)`별 `(occurred_at, record_id)` 순서로 정렬하고 LEAD로 다음 노출을 구한다. 각 노출은 자신의 순서 키 이상·다음 노출의 순서 키 미만인 골에만 후보가 된다. 같은 uid의 다른 기기 노출도 이 순서에 포함한다. 명시적 uid 경로에서는 골·실험별 최대 한 후보만 만든다.

익명·첫 로그인 후보는 그대로 합친 뒤 소유권 경로 전체에서 최신 노출을 고른다. 귀속 기간 검사는 그 다음이며, 최신 노출이 만료됐다고 과거 노출로 되돌아가지 않는다. 경쟁 실험의 분모, 관측 적격성, 부호 있는 보상, 수신 시각 상한과 event ID 동률 규칙을 유지한다.

타임라인은 조회 uid 또는 cid와 관련된 uid·로그인 cid의 보수적인 집합으로 먼저 골 후보를 좁힌다. cid 조회도 다른 기기에서 발생한 uid 구매를 유지한다. 선택한 골에 귀속될 가능성이 있는 모든 실험의 명시적 uid 노출과 익명 cid 노출을 남긴다. 과거 로그인 이력을 잘라 다음/이전 신원 경계를 바꾸지 않으며 최종 타임라인의 사용자 조건과 커서 조건은 그대로 적용한다.

원본의 중복 제거·노출 projection·신원 이력 읽기는 남는다. 따라서 타임라인 전체의 계산·스캔량이 O(1)이 되는 것은 아니다. 관련 없는 사용자가 늘어도 귀속 조인의 골·노출 후보 집합을 유지하는 개선이다. 익명 경로의 후보 조합도 별도로 남아 있어 모든 귀속을 선형 시간에 처리한다고 보장하지 않는다.

[로컬 결과](measurements/temporal-query-results.json)는 같은 입력의 모든 credit 열과 타임라인·arm 결과가 기준 SQL과 일치하는지 먼저 검사한 뒤 한 번 예열·세 번 측정한 중앙값이다.

| 한 uid의 이벤트 수 | 이전 후보 | 현재 후보 | 이전 ms | 현재 ms |
| ---: | ---: | ---: | ---: | ---: |
| 160 | 3,240 | 80 | 35.03 | 5.54 |
| 320 | 12,880 | 160 | 127.04 | 11.01 |
| 640 | 51,360 | 320 | 528.97 | 24.69 |

| 무관한 사용자 수 | 전체 이벤트 | 범위 축소 후 골/노출/후보 | 이전 타임라인 ms | 현재 타임라인 ms |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 60 | 30 / 30 / 30 | 8.79 | 9.51 |
| 40 | 380 | 30 / 30 / 30 | 26.98 | 23.75 |
| 160 | 1,340 | 30 / 30 / 30 | 85.60 | 67.67 |

작은 입력에는 범위 집합 생성의 고정 비용이 있다. 관측 분석까지 같은 범위 필터를 적용하는 시도는 로컬 추가 비용이 커서 채택하지 않았다. arm 조회에는 명시적 uid 구간 최적화만 적용한다. 위 시간과 후보 수는 Basin 실행 계획·bytesScanned·과금 절감률이 아니다. 실제 환경에서는 [EXPLAIN과 predicate pushdown](https://developers.cloudflare.com/basin-sql/reference/limitations-best-practices/)을 확인해야 한다. LEAD는 [지원 window 함수](https://developers.cloudflare.com/basin-sql/sql-reference/#window-functions)다.

기준 SQL 두 파일 `reference-temporal-attribution.ts`, `reference-scoped-sql.ts`는 비교 검증 전용이며 런타임이나 제품 패키지에서 사용하지 않는다. 회귀 검사는 같은 밀리초의 ID 순서, 다른 기기, 익명 경쟁, 만료된 최신 노출, 재전송, Unicode 순서, includeLinked, 페이지 커서, hasEvent와 경쟁 실험 분모를 포함한다.

```sh
node_modules/.bin/esbuild benchmarks/analytics/temporal-query.ts --bundle --platform=node --format=esm --outfile=/tmp/eye-temporal-query.mjs
node /tmp/eye-temporal-query.mjs
npx vitest run --project core test/core/temporal-query.test.ts
```
