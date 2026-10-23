# 수집·학습 쓰기 비용 최적화

2026-10-23. 기준 구현은 `8606a84`이며, 실제 고객 Cloudflare 리소스를 배포하지 않고 로컬 workerd/SQLite에서 변경 전후를 비교했다. 가격표만으로 추측한 최적화와 구분하기 위해 저장 작업을 먼저 측정했다.

## 변경

### 일반 로그

이전 경로는 Queue → 신원 조회 → Subject ingest → durable outbox → alarm/flush → Stream이었다. track은 학습에 직접 사용되지 않고 분석 조회가 event ID로 중복을 제거하므로, Queue와 Subject outbox에 전달 작업을 이중으로 기록하고 있었다.

새 경로는 Queue → 신원 조회 → Stream 배치다. Subject ingest RPC와 outbox 쓰기·삭제를 제거하고, 사용자별 로그 전송 alarm을 만들지 않는다. 익명 사용자의 경우 로그 전송을 위해 Subject DB를 새로 생성할 필요도 없다. 인증된 사용자의 상태 인계와 로그인 이력 처리는 그대로 유지하므로 모든 DO 호출이 사라진 것은 아니다.

최대 8개의 신원/학습 작업이라는 동시성 제한을 유지한다. 로그 라우팅이 모두 끝나면 다른 학습 RPC 완료와 독립적으로 Stream 전송을 시작한다. 전송 크기는 실제 UTF-8 4.5 MB 이하이고, Queue consumer에서도 원본 envelope 크기를 검증한다.

성공한 Stream 그룹만 ack하고 실패한 그룹만 retry한다. 성공한 노출·goal의 ack는 Stream 실패 때문에 취소하지 않는다. 원본 ID·수신 시각·cid·uid·속성을 보존하고 `state_key`를 기존 Subject ID와 일치시켜 cohort JOIN을 유지한다. 지연된 익명 track의 `subject_key`도 원본 신원 기준이며 현재 uid를 소급해서 붙이지 않는다.

학습 outbox는 유지한다. 이전 버전에서 남은 track outbox도 기존 Subject flush가 계속 처리하므로 SQL schema migration은 필요하지 않다. 일반 로그의 장애 복구 경계는 Queue 재시도/DLQ이며, Stream 장기 장애가 Queue 보관 기간을 초과하는 경우 무손실을 보장하지 않는다. 사용자·arm·goal별 선택적 sampling은 추가하지 않았다.

### 관측 통계

shard identity와 세대별 설정은 불변이므로 최초에만 저장한다. await 이후 동시 초기화 가능성도 다시 확인한다. pending 보상 정정은 아직 완료된 표본을 바꾸지 않으므로 moments를 다시 쓰지 않는다. 완료 기여의 추가·정정·취소에서는 기존 감쇠 계산과 moments 쓰기를 수행한다.

revision 원장, pending 압력, sequence, 예약 해제와 snapshot 게시를 유지했다. 완료 0 표본을 없애거나, 보상을 sampling하거나, 학습 반영을 지연시키는 변경은 아니다. 게시와 조회에서 시간 망각을 계속 적용한다.

## 변경 전후 측정

명령: `npx vitest run --project workers test/runtime/ingestion-cost.test.ts`

테스트는 실제 SQL 실행의 `cursor.rowsWritten`과 실제 KV 메서드 호출을 계측한다. I/O 결과를 가짜 성공으로 바꾸지 않는다. Stream에는 로컬 개발 바인딩을 사용한다. 초기 스키마·신원 생성은 측정에서 제외한다.

| 동일 workload의 계측 항목 | 변경 전 | 변경 후 |
| --- | ---: | ---: |
| 재방문 익명 사용자 track 100건: Subject SQL 쓰기 행 | 400 | 0 |
| 같은 workload: Subject KV put | 100 | 0 |
| pending 관측 100회 정정: identity KV put | 100 | 0 |
| 같은 workload: settings KV put | 100 | 0 |
| 같은 workload: moments KV put | 100 | 0 |

첫 workload는 동일 브라우저 100건을 Queue consumer에 전달하고 outbox flush까지 포함했다. 양쪽 모두 alarm이 이미 예약된 warm 상태라 새로운 setAlarm 호출은 0이었다. 따라서 사용자마다 독립적으로 깨어나는 실제 트래픽의 alarm 절감량은 이 숫자에 포함하지 않았다. Identity Registry의 작업도 별도다.

두 번째 workload는 이미 설정을 저장한 shard에서 pending reward만 100번 정정했다. 선택한 세 종류의 중복 쓰기 300회가 사라졌으며, 원장·pending·sequence 등 다른 쓰기까지 없어진 것은 아니다. 정책은 pending=1, 학습 표본 weight=0을 유지했다. 기존 완료 보상·지연 정정·중단·eviction 검사를 함께 수행했다.

이 검사는 네트워크 왕복과 저장 작업 감소를 검증하며 실제 Cloudflare p95·CPU·청구액 측정을 대체하지 않는다. 로컬 단발 실행 시간은 잡음이 커서 속도 향상률로 제시하지 않는다. 일반 로그 가시성은 기존 사용자별 alarm 대기를 제거했지만 최종 Catalog 반영 시간은 여전히 sink와 외부 서비스에 달려 있다.

## 검증과 비용 해석

- 일반 로그 100건의 배치 전송, ID와 원본 신원 보존, 재시도 시 동일 분석 레코드를 검사했다.
- 첫 uid track과 후속 배정의 동일 상태 위치, 로그인 뒤 늦게 도착한 익명 로그의 cohort 연결을 검사했다.
- 느린 학습 RPC가 준비된 로그 전송을 막지 않는 것과 Stream 실패와 학습 성공의 분리, 큰 UTF-8 배치의 분할, 일부 배치 실패, 잘못된 크기의 메시지 격리를 검사했다.
- 이전 최적화 단계에서는 70개 검사, 타입 검사와 빌드, 패키지의 외부 소비자 타입 검사 및 Wrangler dry-run을 수행했다. 최신 실행 결과는 [구현 상태](IMPLEMENTATION.md)에 반영한다.

비용 절감은 실제 track 비율과 관측 정정 횟수에 비례한다. warm track에서 제거한 약 5회의 저장 작업을 기준으로, 월 2,100만 track이면 포함량 초과 단가에서 약 $105의 쓰기 절감에 해당한다. pending 정정은 warm shard에서 회당 3개 KV 쓰기를 추가로 줄인다. 전체 예산 가정과 한계는 [비용 문서](COST.md)를 따른다.

실계정에서는 로그/노출/goal/로그인 비중과 동시 실험 수를 고정한 replay로 DO 요청·rowsWritten·duration, Queue 재시도율, Stream 지연, 학습 반영 지연을 함께 비교해야 한다. 알려진 기존 uid의 실험별 cid 상태 인계 미완료 항목은 이번 변경과 별개로 남아 있다.

## 학습 원장 쓰기 최적화 — 후속 구현

사용자 승인 순서에 따라 중간 shard 갱신 제거, 트랜잭션 내 상태 변경 합치기, 중복 노출 원장 정리, 학습 정정 기한을 구현했다. SWR 정책 캐시와 완전 로컬 배정은 별도 계획이며 이번 구현에 포함하지 않는다.

- pending reward만 바뀌면 shard outbox를 새로 쓰지 않는다. 최초 pending, 완료·중단, 완료 후 기한 내 정정은 전달한다. 최종 보상은 Subject에 내구성 있게 남으며 eviction 후에도 완료된다.
- 한 동기 트랜잭션에서 같은 관측의 변경은 최종 값으로 합친다. Queue에서 인접한 동일 사이트·subject·발생 시각의 goal을 묶고, 실패 시 개별 처리로 분리한다. 같은 관측의 기존 credit 취소와 새 credit 추가도 net delta로 합친다. 배치 안의 동일 goal·발생 시각 상태 조회는 재사용하며 서로 다른 조회는 순차 처리해 consumer의 기존 동시성 상한을 증폭하지 않는다. 순서·신원 경계가 다른 이벤트를 임의로 합치지 않는다.
- 신규 exposure는 exposures에만 저장한다. 순서대로 온 노출의 observation ID는 삽입 전에 결정하고, replay 시 달라지지 않은 연결 행은 UPDATE하지 않는다. events의 기존 중복 행은 maintenance에서 제한된 개수씩 제거한다. 원본 분석 events와 중복 검사는 유지한다.
- 신규 실험은 `correctionWindowMs=7일`로 시작한다. 실험별로 최초 완료 지연 이상, 60일 이하에서 설정 가능하다. 처리 시각이 관측 endAt + correctionWindowMs를 초과하면 학습 reward와 경계를 고정한다. 기존 필드 없는 배정은 60일 정정 동작을 유지한다. 분석 원본·credit은 계속 남기며 정정 기한과 분석 보관 기간을 분리한다. 정정 마감은 오래된 원장 전체의 조기 삭제를 구현했다는 뜻이 아니다.

### 실제 저장 작업 비교

후속 변경 직전 src/test를 별도 로컬 디렉터리에 복사하여 같은 `profiles 100 pending goals` workload를 workerd에서 실행했다. 운영 리소스는 사용하지 않았다. 현재 회귀 검사는 `test/runtime/learning-writes.test.ts`의 `measures pending goal writes`다.

한 사용자의 관측을 미리 열고 최초 pending 전달을 마친 뒤, 같은 발생 시각의 양수 goal 100개를 처리한다. 개별 방식은 매 goal 뒤 outbox flush, 합친 방식은 100개를 한 트랜잭션으로 처리한 뒤 outbox가 완전히 빌 때까지 flush한다. flush 한 번은 export 최대 100개이므로 잔여 기록의 삭제까지 포함한다. 모든 방식의 최종 Subject reward는 100이다.

| 계측 | 변경 전, 개별 처리 | 변경 후, 개별 처리 | 변경 후, 100개 합침 |
| --- | ---: | ---: | ---: |
| Subject SQL rowsWritten | 2,500 | 2,100 | 1,506 |
| Subject KV put/delete 호출 | 400 | 300 | 201 |
| shard SQL rowsWritten | 600 | 0 | 0 |
| shard KV put/delete 호출 | 300 | 0 | 0 |
| 합계 | **3,800** | **2,400** | **1,707** |

초기화·원장 보관 정리·alarm·Experiment snapshot 쓰기는 합계에서 제외한다. 실제 SQL 실행 및 KV 호출을 계측하며 mock 성공으로 대체하지 않는다. SQL 행과 KV 호출 합은 이 workload의 쓰기 작업 비교이며 실제 계정 청구액과 동일하다고 보장하지 않는다. 순차 처리 대비 약 37% 감소, 100개 합침까지 가능한 경우 약 55% 감소다. 실제로 같은 사용자·발생 시각 goal 100개가 함께 오는 빈도가 낮으면 후자의 절감을 기대할 수 없다. raw event와 credit별 기록은 계속 남기므로 100개를 합쳤다고 모든 쓰기가 1/100이 되지 않는다.

검증은 signed goal, 완료 0, eviction, 기한 경계, 늦은 최초 노출, frozen 관측의 역순 노출, 폐기된 관측과 다음 관측의 경계, 동일 ID 재전송, poison 항목 뒤 배치 롤백 및 개별 복구, legacy assignment/실험 생성 호환성을 포함한다. 정정 기한 이후에도 이미 수락한 보상의 마감 전송은 수행한다. 전체 성능·장기 지연 분포와 편향 여부는 실제 트래픽 검증이 남아 있다.

### 독립 리뷰 반영

두 독립 리뷰에서 차단 결함은 보고되지 않았고, 배치 내부의 중복 Site 조회/과도한 fan-out 및 과거 검증·저장 구조 설명을 수정했다. 추가 자체 점검으로 묶음 계측에서 flush 1회 뒤 남은 101개 export의 삭제를 포함하도록 바로잡았다. 위 1,707회는 outbox가 완전히 비었음을 확인한 최종 수치다. 자동 alarm과 가상 시계가 테스트 종료 후 섞이지 않도록 테스트 alarm도 정리했다.
