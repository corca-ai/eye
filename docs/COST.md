# 비용 추정

후속 네 기능 구현은 신원 인계 시 임시 원장, 최대 분당 정책 발행 outbox, 속성 사전·정책 분석 레코드를 추가한다. 로컬 decide는 held decision 쓰기를 만들지 않는다. 아래 월 총액은 이 추가 쓰기·두 sink·실제 미참여율을 계측해 반영한 최신 견적이 아니며, 그대로 운영 비용으로 적용하지 않는다. KV 발행은 이번 구현에 넣지 않았다.

2026-10-23 공식 가격표와 `8606a84`의 구현을 기준으로 작성했다. 금액은 USD, 세금 제외, 월 30일, Workers Standard/Paid와 R2 Standard 기준이다. 실계정 사용량을 측정한 견적은 아니다.

**최신 SWR 계획까지 적용한 비교 시나리오는 월 약 $920–970이다.** 아래 SWR 재추정의 가정에 따른 값이며 구현·실측 견적이 아니다. 최적화 전 비교값은 약 $1,100이다. 실제 비용은 SQLite 쓰기 증폭에 따라 수백 달러에서 $2,000 이상까지 달라질 수 있다.

## 학습 원장 쓰기 최적화 실측 추가

후속 구현의 [측정](PERFORMANCE.md)에서 pending goal 100개 개별 처리의 Subject·shard 쓰기 합계가 3,800에서 2,400으로 줄었다. SQL rowsWritten과 KV put/delete를 계측했으며 초기화·alarm·보관 정리·Experiment snapshot은 제외했다. 해당 workload에서는 goal당 약 14개 쓰기 작업이 줄었다. 예를 들어 동일한 형태의 goal이 월 300만 개라면 초과 쓰기 단가 기준 약 $42/월에 대응한다. 일반 로그 300만 개에 적용하거나 모든 이벤트에 곱해서는 안 된다.

같은 100개 goal을 한 트랜잭션으로 합칠 수 있을 때는 1,707개였지만 그 묶음 크기는 운영 가정이 아니다. 전체 $920–970 추정에 이 테스트의 37–55%를 곱해 할인하지 않는다. 신규 노출 중복 저장 제거와 완료 후 정정 빈도 감소는 별도 workload 계측 후 합산한다. `correctionWindowMs`는 초기 삽입·전체 분석 저장을 없애지 않으며 SQLite 보관 기간 전체를 7일로 줄인 변경도 아니다.

## SWR 계획 반영 재추정 — 2026-10-23

[요청 경로 계획](REQUEST-PATH-PLAN.md)의 fresh 60초 / 최대 나이 5분, 콜드 요청 무대기·미참여, 준비된 배정의 로컬 재사용을 반영했다. KV·Queues·DO·Workers 공식 단가를 다시 확인했다. 다른 저장·분석·운영 로그 비용은 아래 기존 시나리오와 같게 고정하여 증분 비교한다. 소량 미참여로 수집량이 줄어드는 절감은 계산하지 않는다. 이번 추가 추정은 앞선 계획 독립 리뷰 이후 작성한 문서이며 코드 변경이나 실계정 측정은 없다.

### 비교 결과

| 단계 | 월 비용, 반올림 | 의미 |
| --- | ---: | --- |
| 최적화 전 | $1,080–1,100 | 기존 계획 계수 기준 |
| 일반 track 직접 내보내기 반영 | $980–1,000 | 앞서 계산한 기준값; 일부 쓰기 감소만 로컬 계측 |
| SWR + 안전한 기존 배정 로컬 재사용 + held 로그 생략 | $946–966 | 기준값 − $40.50 − $3.65 + $10 |
| 위 단계 + Queue 메시지당 평균 3개 이벤트 | $922–942 | 위 비용에서 Queue $24 절감 |

따라서 현재 계획으로는 약 $920–970/월을 비교 시나리오로 사용하고, 측정 전에는 기존 약 $1,000/월 계획 예산을 크게 내리지 않는 것이 적절하다. 이 범위는 통계적 신뢰구간이나 최대 청구액이 아니다. 아직 후속 단계인 실시간 예약 제거·완전 로컬 신규 선택의 절감은 포함하지 않았다.

### 추가 가정과 계산

- 월 수집 3천만 건, 월 decide 900만 회(하루 30만). 여기서 decide 1회는 한 실험의 배정 조회다. 페이지당 3개 실험에 각각 호출하는 30만 페이지라면 이 수는 3배다.
- decide 중 90%를 안전하게 로컬 처리할 수 있다고 가정한다. 정책 캐시 hit뿐 아니라 신원·관측 상태·배정 증명 유효성까지 통과한 비율이다. 나머지 10%의 준비 비용은 기존 비용에 남겨두며, 그 전부가 미참여한다는 뜻은 아니다.
- 로컬 처리 810만 회 × held 분석 outbox의 예상 제거 쓰기 5행 = 4,050만 행, 초과 단가에서 $40.50 절감. sequence KV와 인덱스 포함 outbox 삽입·삭제를 근거로 한 예상이며 held 전용 실측은 아니다. 기존 track 5행 절감과 대상이 달라 중복 차감하지 않는다. 기존 전체 30행 계수에 decide 비용도 배분되어 있다는 가정을 유지한다.
- 로컬 처리 810만 회 × DO 호출 3회 제거(Subject decide, Experiment getConfig, recordHeldDecision) × $0.15/백만 = 약 $3.65 절감. 신원 조회·alarm·duration 추가 절감은 계산에서 제외한다. 호출이 실제로 제거되어야 절감이며 백그라운드로 옮기는 것만으로는 줄지 않는다.
- 정책 배포·신규 계측·서명 CPU 등의 순증 비용을 월 $10으로 임시 배정했다. 실측값이 아니며 아래 구성 예시를 참고한다. 이 예산이 $5 또는 $20이면 표 전체도 각각 −$5 또는 +$10 변한다.
- 이벤트 메시지당 평균 3개, 각 메시지는 내부 메타데이터 포함 64 KB 이하, 재시도 없음: Queue `(30백만 / 3 × 3 − 1백만) × $0.40/백만 = $11.60`. 기존 $35.60 대비 $24 절감. 같은 호스트 요청에서 실제로 함께 발생하는 이벤트만 묶으며, 평균 3개가 나오지 않으면 절감도 줄어든다.

### 정책 배포는 얼마인가

Workers KV Paid 포함량은 월 읽기 1천만, 쓰기 100만이며 초과는 각각 $0.50/백만, $5/백만이다. DO 내부 SQLite KV와는 다른 제품·단가다. [KV 공식 가격](https://developers.cloudflare.com/kv/platform/pricing/)

사이트 정책이 하나의 스냅샷에 들어가는 경우, 분당 발행은 월 43,200회다. snapshot과 pointer 두 키를 쓴다면 86,400 key writes다. KV 포함량이 남아 있으면 쓰기 추가료 $0, 이미 소진했어도 약 $0.22–0.43이다. 정책 크기·실험 수 때문에 여러 키로 나누면 key 수만큼 증가한다. 무제한 버전 보관·매번 list 호출은 가정하지 않는다.

읽기는 전 세계 분당 한 번이 아니다. isolate별 콜드 읽기와 갱신이 합쳐진다. 한 결정당 최대 한 키 읽기를 시작하고 별도 반복 polling을 하지 않는 구성에서 월 900만 decide라면 읽기 상한 예시는 900만 회다. 포함량이 남아 있으면 $0, 소진했다면 $4.50이다. 이것이 캐시 miss가 적다는 뜻은 아니며 같은 읽기 수라도 사용자 미참여율은 다를 수 있다. 사이트 전체 한 키라는 가정이 깨지거나 다른 요청에서도 갱신하면 다시 계산해야 한다.

발행 자체의 중앙 작업은 KV 요금과 별개다. 예를 들어 3개 실험 × 16개 shard × 43,200회 = 월 약 207만 shard 조회다. 추가 DO 요청료는 초과 단가로 약 $0.31, 각 주기마다 shard당 3행을 새로 쓴다면 쓰기 약 $6.22가 더 든다. 이는 크기 예시이며 16개 shard가 확정 설정이라는 뜻은 아니다. 읽기 전용 합산이면 이 쓰기는 없고, 매 주기 변경 없는 shard를 다시 게시하면 비용이 늘어난다. 기존 게시를 대체한 작업은 기존 비용과 이중 합산하지 않는다. $10 예산은 이 예시와 나머지 소규모 오버헤드를 위한 임시 값이다.

SWR의 waitUntil 실행도 CPU·KV·DO 사용량에 따라 과금된다. 비동기라는 이유로 무료가 되지 않는다. Workers는 wall-clock 대기 대신 CPU를 과금한다. 서명 검증 등에 decide당 추가 CPU가 1ms라면 월 900만 CPU-ms이고 초과 단가로 $0.18이다. 1ms는 성능 측정값이 아니라 계산 예시다. [Workers 공식 가격](https://developers.cloudflare.com/workers/platform/pricing/)

### 민감도와 아직 큰 비용

| 안전한 배정 로컬 처리 비율 | 쓰기 절감 | DO 요청 절감 |
| --- | ---: | ---: |
| 50% | $22.50 | $2.03 |
| 90% | $40.50 | $3.65 |
| 99% | $44.55 | $4.01 |

이 규모에서는 로컬 처리율을 90%에서 99%로 높이는 직접 절감은 약 $4.4/월이다. 높은 재사용률은 비용보다 요청 지연과 참여율에 더 큰 의미가 있다. 반면 유효한 상태가 없어 준비가 반복되면 기존 비용을 초과할 수도 있어 미참여 뒤 준비 재시도 횟수를 함께 측정한다.

| Queue 메시지당 평균 이벤트 | 월 Queue 비용 |
| --- | ---: |
| 1 | $35.60 |
| 2 | $17.60 |
| 3 | $11.60 |
| 5 | $6.80 |

Queue의 sendBatch 호출 수가 아니라 실제 메시지 수와 크기로 계산한다. [Queues 공식 가격](https://developers.cloudflare.com/queues/platform/pricing/)

가장 큰 항목은 여전히 SQLite 쓰기다. 기존 9억 행 − 일반 track 절감 1.05억 − held 절감 0.405억 = 월 약 7.545억 행이다. 포함 5천만을 빼면 **쓰기만 약 $704.50/월**이다. 입력당 유효 계수는 약 25.15행이고, 한 행/이벤트를 더 줄일 때 약 $30/월을 절감한다. SWR만으로 실제 노출·goal·관측·정정 쓰기가 사라지지 않으므로 월 수십 달러 수준으로 내려간다고 추정할 근거는 없다. [DO 공식 가격](https://developers.cloudflare.com/durable-objects/platform/pricing/)

나머지 조건을 위 평균 3개 포장 시나리오와 같게 고정하고, 최종 총 쓰기 계수가 10 / 15 / 25.15 / 30행이면 총액은 각각 약 $467–487 / $617–637 / $922–942 / $1,067–1,087이다. 이는 쓰기만 바꾼 민감도이며 10행이나 15행을 달성했다는 뜻이 아니다.

운영 로그는 기존 가정대로 $48을 유지했다. 2026-12-01 요금 전환과 로그 크기·보존 기간이 기존 문서 예시와 같다면 약 $13.63으로 바뀌어 약 $34 낮아진다. 이는 SWR 절감으로 계산하지 않는다. 계정 포함량은 다른 앱과 공유하고, 기존 Paid 고객은 $5 구독료를 중복 지불하지 않는다.

## 최적화 후 갱신

아래 원래 추정은 비교 기준으로 남긴다. 후속 구현은 일반 track을 Queue→Stream으로 직접 내보내고, shard의 불변 메타데이터와 pending moments 반복 쓰기를 제거했다. [측정 결과](PERFORMANCE.md)에 따르면 재방문 익명 사용자의 track 100건에서 Subject SQL 쓰기 400행과 KV put 100회를 제거했다. 신원 조회나 신규 사용자 초기화까지 0이 되었다는 뜻은 아니다.

하루 100만 입력 중 70%가 같은 형태의 일반 track이라면 월 2,100만 × 5행 = 약 1.05억 쓰기 감소, 초과 단가 기준 약 $105/월에 해당한다. 기존 시나리오의 다른 비용을 고정하면 약 $980–1,000/월이다. Subject RPC·alarm·duration 감소와 shard의 반복 쓰기 절감은 이 계산에 추가 반영하지 않았다. 실제 이벤트 구성과 계정 청구 지표로 재산정해야 하며, 전체 비용의 확정 할인율로 사용하지 않는다.

## 범위와 가정

하루 100만 건은 `track`·`exposure`·`goal`·신원 이벤트를 합친 수집 건수로 해석한다. 페이지뷰 100만 건에 각종 실험 노출이 추가되는 경우는 더 큰 부하다. 월 입력은 3천만 건이다. 사이트와 고객 Cloudflare 계정 하나를 가정하며, 고객마다 자기 계정에 지불한다.

기존 호스트 서비스 자체의 HTTP 요청·업무 CPU 비용은 제외하고 Eye가 추가하는 비용을 계산한다. 아래 기본 시나리오는 계정의 포함 사용량을 Eye에 배분한다. 다른 앱이 이미 소진했다면 추가 요금이 늘어난다. $5 구독료는 계정당 한 번이며 기존 Paid 고객의 증분 비용에는 다시 더하지 않는다.

확정되지 않은 이벤트 구성·활성 사용자·조회 빈도를 사용자 요구사항으로 간주하지 않는다. 다음은 비용 민감도를 보기 위한 가정이다.

| 변수 | 기본 시나리오의 가정 |
| --- | --- |
| 이벤트 크기 | 원본 평균 약 1 KB, Queue 메시지는 메타데이터 포함 64 KB 이하 |
| 배정 조회 | 하루 30만 회; 수집 이벤트 수와 별개 |
| 실험 | 동시 3개 정도의 혼합 사용; goal은 관련 실험 수만큼 파생 credit 생성 |
| SQLite 쓰기 | 입력 이벤트당 평균 30행. 배정·정정·인덱스·KV·alarm·outbox·보관 정리까지 배분한 합계 |
| DO 요청 | 입력당 평균 7회, 월 2.1억 회. RPC와 alarm을 포함 |
| DO duration | 중복 시간 제거 후 월 누적 활성 객체 시간 2,100만 초, 즉 2,625,000 GB-s |
| DO 저장 | 월평균 150 GB. 실제로는 사용자별 DB 기본 크기·인덱스·관측 수에 따라 변함 |
| Worker CPU | Eye의 producer/consumer 등 합계 월 1.5억 CPU-ms; DO duration과 구분 |
| Worker 요청 | Queue consumer·분석 등 Eye 추가 요청 월 1천만 이하 |
| 분석 내보내기 | 원본·파생 행·revision 포함 비압축 120 GB/월; 압축 후 30 GB/월 가정 |
| R2 저장 | 삭제 없이 운영한 3개월차 평균 75 GB: 시작 60 GB, 종료 90 GB |
| 분석 조회 | 월 1,500회, 쿼리당 압축 데이터 평균 5 GB 스캔 |
| 운영 로그 | 월 1억 log events. 현재 `head_sampling_rate: 1`; RPC 수와 1:1이라고 단정하지 않음 |
| 메타데이터 작업 | R2 A 200만, B 2천만, Catalog 200만 operation/월의 예산 가정 |

특히 30행과 7회는 실측값이 아니다. 코드 경로를 보고 둔 계획 계수이며, 위 사용 패턴이 반드시 그 계수를 만든다는 뜻도 아니다. 고유 사용자 수, 관측창 길이, 로그인 비중, 노출 빈도, 지연 정정률로 달라진다. DO duration의 100ms/요청 환산도 CPU 벤치마크에서 얻은 값이 아니다. 같은 객체에서 겹치는 요청 시간을 중복 계산하지 않아야 한다.

## 공식 단가

| 항목 | 월 포함량 | 초과 단가 |
| --- | --- | --- |
| Workers | $5/계정, 요청 1천만, CPU 3천만 ms | 요청 $0.30/백만, CPU $0.02/백만 ms |
| Queues | 100만 operation | $0.40/백만 operation |
| DO 요청 | 100만 | $0.15/백만 |
| DO duration | 400,000 GB-s | $12.50/백만 GB-s |
| DO SQLite 쓰기 | 5천만 행 | $1/백만 행 |
| DO SQLite 읽기 | 250억 행 | $0.001/백만 행 |
| DO SQLite 저장 | 5 GB-month | $0.20/GB-month |
| R2 Standard 저장 | 10 GB-month | $0.015/GB-month |
| R2 Class A / B | 100만 / 1천만 요청 | $4.50 / $0.36 per 백만 |
| Pipelines SQL transform | 50 GB | $0.04/GB |
| Pipelines Iceberg sink | 50 GB | $0.06/비압축 GB |
| Catalog operations | 100만 | $9/백만 |
| Catalog compaction | 10 GB, 100만 objects | $0.005/GB, $2/백만 objects |
| Basin SQL | 10 GB | $0.0025/압축 스캔 GB, 쿼리당 최소 10 MB |
| Workers Logs, 2026-11-30까지 | 2천만 log events | $0.60/백만 |

출처: [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Queues](https://developers.cloudflare.com/queues/platform/pricing/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), [Pipelines](https://developers.cloudflare.com/basin-pipelines/platform/pricing/), [Catalog](https://developers.cloudflare.com/basin-catalog/platform/pricing/), [Basin SQL](https://developers.cloudflare.com/basin-sql/platform/pricing/), [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

Service Binding 호출에 Worker 요청료를 다시 붙이지 않는다. CPU는 호출 경로 전체에서 발생한다. DO RPC는 별도 DO 요청이며, SQLite의 KV 메서드·삭제·setAlarm도 과금 대상이다. 인덱스 갱신은 추가 행 쓰기로 계산된다. DO duration은 128 MB 할당량과 활성 wall-clock 기준이고 포함량 초과분의 청구 단위 올림을 적용한다. [Service Binding 과금](https://developers.cloudflare.com/workers/platform/pricing/#service-bindings), [DO 과금](https://developers.cloudflare.com/durable-objects/platform/pricing/), [SQLite 인덱스 쓰기](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## 하루 100만 건 기본 시나리오

| 항목 | 월 비용, 대략 |
| --- | ---: |
| Workers 구독 + 추가 CPU | $7.40 |
| Queues | $35.60 |
| DO 요청 | $31.35 |
| DO duration | $37.50 |
| DO SQLite 쓰기 | **$850.00** |
| DO SQLite 저장 | $29.00 |
| DO SQLite 읽기 | $0, 250억 행 이내 가정 |
| Workers Logs | $48.00 |
| Pipelines transform + Iceberg sink | $7.00–26.20 |
| R2 저장 | 약 $1 |
| R2 A/B operations | $8.10 |
| Catalog operations | $9.00 |
| Basin SQL 조회 | $18.73 |
| 합계 | **약 $1,080–1,100/월** |

합계 범위는 이 시나리오 안에서 transform 처리량만 달리한 것이다. 추정 전체의 오차 범위가 아니다. 운영 예산은 계수의 불확실성을 반영해 별도로 여유를 둬야 한다. 부가세·환율·Enterprise 계약·다른 앱의 포함량 소비·비정상 재시도는 포함하지 않았다.

계산 예:

- Queue: 메시지 3천만 × 쓰기·읽기·삭제 3회 = 9천만 operations. `(90 − 1) × $0.40 = $35.60`. 현재 코드는 sendBatch 안에 이벤트별 메시지를 넣으므로 배치 크기 100으로 요금이 1/100이 되지 않는다. 재시도와 64 KB 초과 메시지는 추가 비용이다.
- SQLite 쓰기: `3천만 × 30 = 9억 행`, `(900 − 50) × $1 = $850`.
- DO duration: `2,100만 초 × 0.125 GB = 262.5만 GB-s`. 40만 포함분을 빼고 백만 GB-s 단위로 올림하면 `$37.50`.
- SQL 조회: `1,500 × 5 = 7,500 GB`, `(7,500 − 10) × $0.0025 = $18.725`.

Pipelines는 5개의 `INSERT ... SELECT ... WHERE table_name`으로 분기한다. transform 과금 처리량을 입력의 1–5배인 120–600 GB로 잡았다. 이는 실행계획의 공유 처리를 확인하지 못한 민감도 범위다. sink는 각 행이 자기 테이블 하나로 가므로 120 GB이며, 5배로 중복 계산하지 않는다.

Catalog/R2 operation 수는 측정 전 예산 가정이다. 현재 60초 roll interval에서 5개 sink가 계속 데이터를 받으면 월 최대 약 216,000번의 시간 기준 flush 기회가 있다. 하나의 flush가 Iceberg 메타데이터를 포함해 여러 작업을 만들 수 있고 크기 기준 roll도 있으므로, 이를 파일 수나 과금 작업 수의 보장값으로 사용하지 않는다. 자동 compaction을 활성화하면 별도 비용이 생긴다. 현재 설치 스크립트는 이를 명시적으로 활성화하지 않으므로 기본 합계에는 넣지 않았고, 실계정 기본 설정도 확인해야 한다.

## 가장 중요한 민감도

하루 100만 건일 때 쓰기 계수만 달리하면 다음과 같다. 다른 비용을 같은 기본 시나리오로 고정한 비교다.

| 평균 과금 쓰기/입력 이벤트 | 월 쓰기 행 | SQLite 쓰기 비용 | 나머지 기본 비용 포함 |
| --- | ---: | ---: | ---: |
| 10 | 3억 | $250 | 약 $500 |
| 15 | 4.5억 | $400 | 약 $650 |
| 30 | 9억 | $850 | 약 $1,100 |
| 60 | 18억 | $1,750 | 약 $2,000 |
| 100 | 30억 | $2,950 | 약 $3,200 |

계수 1행 차이가 이 규모에서 월 약 $30이다. 노출·goal·동시 실험이 많으면 다른 비용도 함께 증가하므로 위 합계는 실제 workload별 상한이 아니다.

입력량을 낮추고 30행 계수를 유지하면, 하루 1만 / 10만 / 100만 건의 **SQLite 쓰기만** 각각 $0 / $40 / $850이다. 계정 포함량 때문에 규모를 1/10로 줄인다고 전체 청구액이 정확히 1/10이 되지는 않는다.

조회 비용은 한 사용자 결과 100행이어도 크게 달라질 수 있다. `LIMIT`는 반환 행 수를 제한하며 스캔 byte의 상한이 아니다. 월 1,500회 조회가 각각 1 / 5 / 60 GB를 읽으면 SQL 비용은 약 $3.73 / $18.73 / $224.98이고 R2 read operations는 별도다. 실제 압축·partition pruning·파일 수·JOIN 실행계획을 확인해야 한다.

## 최적화 전 구현에서 쓰기 비용이 생기는 이유

`SubjectObject.ingest()`는 일반 track을 영구 이벤트 원장에 넣지는 않지만, 분석 outbox에 넣는다. `effect()`가 sequence KV와 outbox 행을 쓰고 `flush()`가 outbox를 삭제한다. outbox에는 기본키와 별도 인덱스가 있다. 사용자별 alarm 예약·처리·해제도 추가된다.

최적화 전 기준에서 노출은 events와 exposures에 기록되며(현재 신규 노출은 exposures 한 곳에 저장), 새 관측은 Subject와 ObservationShard에 저장된다. goal은 관련 실험별 credit과 관측 reward를 갱신한다. shard의 순간 통계·pending·release·sequence와 Experiment의 snapshot에도 쓰기가 생긴다. 뒤늦은 이벤트와 60일 경과 원장 삭제는 추가 작업이다.

따라서 관측을 0 보상까지 정확히 마감하고 정정 가능한 학습 원장을 유지하는 비용과, 일반 로그를 내보내기 위한 비용을 구분해야 한다. goal value를 실험 수로 나눠도 저장 작업 수는 그만큼 줄지 않는다. 최소 arm 유지 기간이 길어도 현재 구현은 held decision을 분석용으로 남기므로 배정 조회가 공짜가 되지는 않는다.

## 시간에 따라 달라지는 비용

**60일 조회 범위가 R2 물리 삭제를 의미하지 않는다.** 현재 구현은 오래된 분석 데이터를 자동 삭제하지 않는다. 월 압축 30 GB가 쌓이고 별도 중복 파일이 없다고 하면 3개월차 월평균 75 GB, 12개월차 월평균 345 GB이고 저장료는 각각 약 $1 / $5다. snapshot·compaction 잔여 파일과 metadata는 실제 크기에 추가된다. Identity Registry 메타데이터와 실험 상태도 모두 60일 후 사라지는 구조는 아니다.

2026-12-01부터 Workers Logs는 GB 기반 Observability 요금으로 바뀐다. Paid는 수집 50 GB와 저장 12 GB-month 포함, 초과 수집 $0.25/GB와 저장 $0.10/GB-month다. [변경 예정 공식 요금](https://developers.cloudflare.com/observability/pricing/).

예를 들어 log event 1억 개가 enrichment 포함 평균 1 KB라면 수집 100 GB/월이다. 7일 보존과 균일 유입을 가정하면 약 23.3 GB-month여서 약 $13.63다. 이는 현재 개수 기준 $48보다 낮지만, 로그 크기·추가 traces·계정 공유량이 달라지면 결과도 달라진다. 앱이 수집하는 분석 이벤트와 플랫폼의 운영 로그는 별개의 데이터다.

## 비용을 줄일 우선순위와 검증

1. 일반 track의 전달을 사용자별 durable outbox를 거치지 않는 경로로 분리했다. 허용된 소량 유실 범위와 특정 사용자·arm에 치우친 누락이 생기지 않는 조건을 지켜야 한다. 학습 원장의 정정·중복 처리까지 제거하자는 의미는 아니다.
2. 실제 arm을 결정하는 지점에서 decide를 호출하고, 반복 호출의 held decision 기록 비용을 측정한다.
3. shard snapshot 게시와 outbox 처리의 합치기를 검토한다. 동일 트랜잭션에 넣는 것만으로 과금 행 수가 줄지는 않는다. 실제 쓰기 횟수를 줄여야 한다.
4. 플랫폼 운영 로그의 sampling을 조정한다. 실험·보상 데이터 sampling과 혼동하지 않는다.
5. 분석 쿼리별 scan byte, R2 GET 수, 파일 개수를 보고 partition·compaction·조회 캐시를 선택한다. 60초 roll과 사용자 타임라인 조회를 함께 측정한다.

측정은 track / 신규 관측 exposure / 반복 exposure / goal의 실험 수 1·3·10 / held·신규 decide / 로그인 / 지연 정정 / 원장 정리를 구분해 수행한다. SQL cursor의 rowsWritten/rowsRead, KV·alarm 작업, DO request·duration, analytics byte와 실제 청구 지표를 대조한다. 같은 이벤트 수여도 사용자 분포와 짧은 관측창이 비용을 바꾼다. 이 측정 전에는 위 $1,100을 확정 견적으로 사용하지 않는다.
