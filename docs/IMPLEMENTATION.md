# 구현 진행과 검증 증거

전체 범위는 DESIGN.md와 TECHNICAL_DESIGN.md를 따른다. 이 문서는 완료한 구현과 검증의 한계를 구별하며, 미완료 항목을 범위에서 제외하지 않는다.

## 2026-10-23 현재 상태

| 구성 | 구현과 로컬 검증 | 남은 검증 / 작업 |
| --- | --- | --- |
| 라이브러리·Service Binding·API | 수집·배정·goal/arm 관리·분석, 요청 단위 waitUntil 배치 | 실제 호스트 운영 통합 |
| 비동기 수집 | Queue 크기별 배치, 소비 병렬성 제한, track 직접 내보내기, 동일 subject·시각 goal 합침, 검증·중복·역순 전달 | 장시간 장애·재시도 부하 |
| uid·cid | 신규 uid의 전체 인계, 기존 uid의 누락 실험 인계·원장 이전·재시도, uid 우선·로그인 구간·로그아웃 | 대규모 개인 이력의 인계 부하·복합 계정 전환 경합 |
| 관측·보상 | 고정 구간, 완료된 0, interrupted, 실험별 정정 기한, pending 보상 전달 생략, 공통 goal 균등 귀속·signed decay | 더 넓은 이벤트 수준 장기 시뮬레이션 |
| 선택 정책 | 안정적인 모멘트, 망각·낙관적 보너스·탐색 확률·pending | 실제 트래픽 추세별 튜닝 |
| DO·복구 | Site / Experiment / Observation Shard / Subject / Identity Registry, SQLite·CAS·outbox·alarm | 다중 RPC 응답 유실의 장기 검증, identity 메타데이터 보관 정리 |
| 분석 내보내기 | 7개 테이블 schema, revision, 원본 identity 보존, 4.5 MB 이하 UTF-8 배치 | 전체 테이블·조회 API의 원격 검증 확대 (track·goal·exposure 집계는 확인) |
| 분석 조회 | arm·속성 cohort·arm 시계열·실제 배분·정책 발행 이력·속성 키/타입, goal·시계열·속성값, cid/uid 타임라인·cursor | 실제 Basin 엔진·타입 반환·예산·6천만 행 조회; 기존 설치의 두 신규 sink migration |
| 설치·패키지 | 로컬 init, 명시적 provision 스크립트, 성공 단계 checkpoint, 외부 소비자 타입·번들 | 표준 provision 스크립트의 실계정 검증, 버전 업그레이드·스키마 migration |
| 성능 | 순수 계산 benchmark, 번들 크기, 제한된 10/100/200 req/s 원격 측정 | 실제 지역별 p50/p95/p99, burst·저장량·스캔량·운영 비용 |

이번 재점검의 재현 사례와 수정 내역은 [코드 점검 결과](REVIEW-2026-10-23.md)에 기록했다.

일반 로그의 Queue→Stream 직접 전송과 shard 쓰기 절감은 [최적화 검증](PERFORMANCE.md)에 별도로 기록했다.

## 검증 증거

- `npm run check`: 엄격한 TypeScript, 116개 검사, JS·선언 파일 빌드. 결과는 해당 명령의 최종 실행과 함께 갱신한다.
- `npm run check:package`: tarball을 별도 임시 프로젝트에 풀어 호스트 타입 검사(`skipLibCheck=false`)와 생성 Worker의 Wrangler dry-run을 수행한다. 호스트의 전역 Env에 의존하지 않는다.
- 변경 후 생성 Worker bundle은 144.21 KiB / gzip 32.91 KiB이며 외부 소비자 타입 검사와 dry-run이 통과했다. 별도로 cf CLI를 사용한 테스트 계정 배포와 제한된 원격 검증도 수행했다.
- workerd/SQLite에서 동시 배정 20개, eviction 복원, arm 추가·중지, 설정 변경 후 hold, revision 정정, 완료 0, 역순 노출·goal, 오래된 마지막 노출 anchor를 검사한다.
- 실제 로컬 Queue로 노출과 goal이 전달되어 정책에 반영되는 것을 확인했다. 요청 전송을 지연시킨 검사에서도 수집 함수는 즉시 반환한다.
- 가입 보상이 익명 상태 인계 중 사라지는 회귀를 재현해 수정했다. 새 uid는 원래 Subject 상태를 그대로 소유하며 관측을 복제·중단하지 않는다. Queue에서 로그인보다 늦게 도착한 익명 노출도 원래 상태로 라우팅한다.
- 익명 이벤트가 로그인 후 처리되어도 원본 uid를 덮어쓰지 않는다. 분석의 state_key는 인계 전후 이벤트·관측 연결에 사용하며 source cid·uid와 구분한다.
- 분석 SQL을 SQLite의 실제 relational 연산으로 실행해 최신 revision 우선, interrupted 정정, goal별 조회의 0 분모, 반복 이벤트 semijoin, signed 원본 합계, 로그아웃 경계·cursor, SQL literal 처리를 검사한다. Basin JSON 함수만 문서의 계약에 맞춰 적용하므로 원격 엔진 검증을 대체하지 않는다.
- 설치 검사에서는 CLI 경계만 가짜 실행 파일로 대체해 실패 후 완료 단계 재사용, token 출력 제거, Stream ID 반영, 기존 디렉터리 보호를 확인한다. 실제 리소스 생성은 수행하지 않는다.
- TypeScript 정책으로 540일·7일 지연 피드백·중간 추세 변화를 검사했다. 매우 큰 signed 보상(±1e300)과 작은 보상(±1e-300)의 모멘트도 검사한다. 무한 정밀도를 주장하지 않는다.

`npm run benchmark`는 로컬 Node.js의 순수 계산 비용만 측정한다. 기존 측정은 2개 arm 0.57µs, 16개 1.70µs, 64개 6.11µs의 배치 평균이다. Cloudflare 요청 지연이나 처리량 증거로 사용하지 않는다.

## 구현 중 해결한 문제

- RPC가 null prototype 객체를 전송하지 못해 속성·통계 payload를 일반 객체로 만들고 `Object.fromEntries`로 특수 키를 보존했다.
- 장기 pending을 단일 Experiment DO에 쌓지 않도록 관측 shard의 pending 원장·절대 스냅샷과 짧은 예약 해제를 연결했다.
- analytics 장애가 학습 갱신을 막지 않도록 outbox 종류별 조회와 게시 순서를 분리했다. Stream 요청 한도는 개수뿐 아니라 실제 UTF-8 byte로 제한한다.
- 진행 중 설정 세대가 바뀌어도 기존 arm의 최소 유지와 관측 설정을 보존한다.
- 조회 시 먼저 complete를 고르면 이후 interrupted revision이 사라지는 오류를 피한다. 특정 goal 조건은 완료 관측 분모를 줄이지 않는다.

Cloudflare Vitest의 [처리된 RPC 예외를 unhandled rejection으로 보고하는 문제](https://github.com/cloudflare/workers-sdk/issues/14736)는 예상된 거부를 실제 DO 내부의 `runInDurableObject`에서 검사해 우회한다. 전역 오류 무시나 제품 코드의 예외 억제를 사용하지 않는다.

## 다음에 해결할 경계

1. 기존 uid의 누락 실험 인계를 구현했다. source를 영속 redirect로 동결하고 50행 단위로 target에 임시 저장한 뒤 한 로컬 트랜잭션에서 적용한다. 중단·응답 유실은 같은 source/row ID로 재개한다. 기존 uid 배정은 우선하고 누락 실험의 배정·관측·누적 보상은 유지한다. target 수락 후 source 원장은 alarm에서 1,000행씩 회수하고 최소 redirect 정보만 남긴다. 원래 shard의 표본 ID와 revision을 보존하고 지연 사건은 원본 신원과 연결 시각으로 계산한다. 개인 이력이 매우 큰 경우의 처리 시간·저장 증폭과 복합 계정 경합의 원격 검증은 남아 있다.
2. Identity Registry의 장기 epoch/claim 메타데이터 정리와 다중 기기·계정 전환 중 RPC 실패를 검증한다. UID home과 유효한 지연 이벤트의 경로를 지우면 안 된다.
3. 현재 15분 토큰 버전으로 갱신 주기를 포함한 지속 부하와 지역별 배정 지연을 측정한다. 테스트 환경의 Stream→Catalog→SQL 일부 집계는 확인했지만 전체 분석 API와 1천만/6천만 행의 계획·스캔량·지연은 남아 있다.
4. 위 경계와 측정이 끝나기 전에는 운영 준비 완료나 전체 요구사항 완료로 표시하지 않는다. 60일 이전 분석 데이터 삭제·백업 정책은 사용자의 결정대로 이번 범위 밖이다.


학습 원장 최적화는 [변경 전후 쓰기 계측](PERFORMANCE.md)에 기록했다. 기존 workerd RPC disposal 경고 외에 poison ID의 실패·복구 테스트에서는 RPC에서 처리된 예외 로그가 출력될 수 있다. 테스트 실패와 구분한다. SWR 정책 발행·서명 상태의 로컬 재사용·명시적 준비 API는 [빠른 배정](FAST-DECISIONS.md)에 구현 계약을 기록했다. KV 배포와 완전 로컬 신규 선택은 후속 최적화다.

추가 분석 범위는 후속 답변 A로 확정했다. 시간별 arm 성과·실제 배분 비율, arm별 배정·노출 횟수, 정책 선택 확률 변경 이력, 수집 속성 키·타입 목록을 모두 구현한다. 각각 armSeries/traffic/policies/attributeKeys로 구현하고 로컬 SQL 의미를 검증했다. 실제 Basin 검증은 남아 있다.

실험·arm 수명주기도 후속 답변으로 확정했다. 실험 전체 일시중지·재개·영구 삭제와 arm 영구 삭제 API를 구현했다. 삭제 후 과거 기록·보상과 기존 지연 귀속 규칙을 보존하고, 삭제한 실험 ID는 사이트 내에서, arm ID는 해당 실험 내에서 재사용하지 않는다. 실험 전체 중지·삭제 시 모든 arm을 배정 대상에서 제외한다. 정책 갱신 지연은 합의한 SWR 계약을 따른다.


## 네 항목 구현의 독립 리뷰

두 독립 리뷰어가 변경 전체를 검토했다. source 원장의 영구 잔류, 일별 속성 사전과 시간 단위 조회의 불일치, goal마다 노출 이력을 전부 읽는 회귀를 지적했고 모두 반영했다. target 수락 뒤 source 데이터를 단계적으로 회수하며 redirect는 유지한다. 속성 사전은 UTC 날짜 기준 coverage를 명시한다. 마지막 노출은 SQL cursor에서 첫 적격 항목을 찾으면 중단한다. 5,001개 노출이 있는 테스트에서 마지막 노출 조회의 rowsRead가 20 미만인 것을 확인했다. 인계 후 source 정리와 지연 재전송, 하루 안의 시간 단위 속성 조회도 검사했다.

이 단계의 검증은 12개 파일 94개 테스트와 외부 소비자 타입·생성 Worker dry-run이었다. 이후 검증과 배포 결과는 아래를 따른다.

## 최신 배포와 도입 판단

현재 로컬 검증은 15개 파일 116개 테스트, 외부 소비자 타입·생성 Worker 번들 검사다. 테스트 Worker에 15분 배정 토큰을 배포하고 실제 발급을 확인했다. 15분 버전의 갱신을 포함한 지속 부하는 아직 실행하지 않았다.

이전 5분 토큰 버전의 제한된 200 req/s 측정에서 재방문자 미참여율은 4.48%였다. 클라이언트 준비 동시성 4개의 병목이 포함되므로 SDK 처리 한계로 해석하지 않는다. 신원 시각 검증 수정 후 별도 100 req/s·1분 진단에서는 track·goal 6,711개 집계가 일치했다. 전체 MAB 경로의 장기 전달·무편향성 증거는 아니다. 조건·버전별 수치는 [최신 성능 기록](PERFORMANCE.md)을 따른다.

현재는 제한적 시범 도입 단계다. 서비스 원본과 로그·goal을 대조하고, 기본 화면 fallback을 연결한 뒤 작은 실험부터 확대한다. 지속 부하, 신원 메타데이터 장기 정리, 복합 장애·계정 전환 검증이 남아 있다. 신규 첫 요청 미참여와 재방문자 갱신 실패는 분리해 측정한다.
