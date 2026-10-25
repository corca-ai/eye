# 원본 분석의 조회 구조 개선

기준 `af6f7a8`. 수집량·보상 수학·분석 API는 유지하고 원본 조회의 입력과 조인 구조를 바꾼다.

## 변경과 정확성 조건

관측·배정 재구성은 원본 노출을 조회 구간의 시작부터 읽는다. 관측 시작 또는 배정 시각이 from 이상이면 해당 노출도 from 이상이기 때문이다. to 뒤의 노출은 유지한다. 실제 첫 노출이 배정 뒤에 늦게 발생할 수 있어 이를 to로 자르면 안 된다. 물리 관측·배정 행과의 병합, 최초 노출 속성 선택, receivedBefore와 보관 기간 기준은 유지한다.

골 귀속 후보는 명시적 uid, 첫 로그인으로 연결된 익명 구간, 익명 cid의 세 가지 상호 배타적인 소유권 경로로 구성한다. 각 경로에 동등 조인 키를 노출해 전체 골과 노출을 시간 조건으로 먼저 연결하는 구조를 피한다. 경로를 합친 후에 실험별 최신 노출을 선택하고, 귀속 기간 검사 → 실험 수 분할 → 관측 적격성 검사 순서를 유지한다. 대상 실험으로 먼저 거르지 않으므로 경쟁 실험의 분모가 보존된다.

UNION은 각 경로의 골/노출 ID가 유일하고 경로가 배타적이므로 UNION ALL과 같은 후보를 만든다. 기존 원격 기록에서 확인된 Basin의 분산 UNION ALL 문제를 피해 사용한다. 골·로그인 이력과 경쟁 실험 노출의 전체 문맥은 유지하며, 모든 조회를 무조건 from/to로 제한하는 최적화는 아니다.

## 검증과 측정

변경 전 SQL은 `benchmarks/analytics/reference-*.ts`에 고정했다. 현재 SQL과 같은 원본 스냅샷에서 모든 credit 열, pending 관측·배정 행을 비교한다. 명시적 uid·익명 cid·첫 로그인·로그아웃/재로그인·다른 기기·동일 시각 ID 순서·재전송·긴/짧은 귀속 기간·음수 골·경쟁 실험·반복 노출 속성을 포함한다. 기존 분석 통합 검사도 함께 실행한다.

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
