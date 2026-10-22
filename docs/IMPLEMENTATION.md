# 구현 진행과 검증 증거

전체 범위는 DESIGN.md와 TECHNICAL_DESIGN.md를 따른다. 이 문서는 완료한 구현과 검증의 한계를 구별하며, 미완료 항목을 범위에서 제외하지 않는다.

## 2026-10-23 현재 상태

| 구성 | 구현과 로컬 검증 | 남은 검증 / 작업 |
| --- | --- | --- |
| 라이브러리·Service Binding·API | 수집·배정·goal/arm 관리·분석, 요청 단위 waitUntil 배치 | 실제 호스트 운영 통합 |
| 비동기 수집 | Queue 크기별 배치, 소비 병렬성 제한, 검증·중복·역순 전달 | 장시간 장애·재시도 부하 |
| uid·cid | 신규 uid의 익명 상태 전체 인계, 기존 uid 우선, 기기 공유, 로그인 구간·로그아웃 | 기존 uid의 일부 실험만 비어 있는 경우의 인계 보완, 복합 계정 전환 경합 |
| 관측·보상 | 고정 구간, 완료된 0, interrupted, 지연 정정, 공통 goal 균등 귀속·signed decay | 더 넓은 이벤트 수준 장기 시뮬레이션 |
| 선택 정책 | 안정적인 모멘트, 망각·낙관적 보너스·탐색 확률·pending | 실제 트래픽 추세별 튜닝 |
| DO·복구 | Site / Experiment / Observation Shard / Subject / Identity Registry, SQLite·CAS·outbox·alarm | 다중 RPC 응답 유실의 장기 검증, identity 메타데이터 보관 정리 |
| 분석 내보내기 | 5개 테이블 schema, revision, 원본 identity 보존, 4.5 MB 이하 UTF-8 배치 | 실제 Stream→Catalog 스키마·전달 검증 |
| 분석 조회 | arm·속성 cohort, goal·시계열·속성값, cid/uid 타임라인·cursor | 실제 Basin 엔진·타입 반환·예산·6천만 행 조회 |
| 설치·패키지 | 로컬 init, 명시적 provision 스크립트, 성공 단계 checkpoint, 외부 소비자 타입·번들 | 실계정 provisioning, 버전 업그레이드·스키마 migration |
| 성능 | 순수 선택 계산 benchmark, 번들 크기 확인 | 실제 지역별 p50/p95/p99, burst·저장량·스캔량·운영 비용 |

이번 재점검의 재현 사례와 수정 내역은 [코드 점검 결과](REVIEW-2026-10-23.md)에 기록했다.

## 검증 증거

- `npm run check`: 엄격한 TypeScript, 61개 검사, JS·선언 파일 빌드. 결과는 해당 명령의 최종 실행과 함께 갱신한다.
- `npm run check:package`: tarball을 별도 임시 프로젝트에 풀어 호스트 타입 검사(`skipLibCheck=false`)와 생성 Worker의 Wrangler dry-run을 수행한다. 호스트의 전역 Env에 의존하지 않는다.
- 현재 생성 Worker bundle은 105.49 KiB / gzip 24.60 KiB다. 실제 배포는 하지 않았다.
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

1. 현재 Identity Registry는 uid당 상태 위치를 고정한다. 기존 uid가 다른 실험의 상태를 이미 가진 경우, 새 cid에만 있던 실험을 per-experiment로 인계하는 경로가 아직 연결되지 않았다. 단순히 배정만 복사하면 가입 보상·진행 중 관측을 잃을 수 있으므로 상태 이전과 재시도 계약을 함께 해결해야 한다. 확정된 uid 우선 규칙은 유지한다.
2. Identity Registry의 장기 epoch/claim 메타데이터 정리와 다중 기기·계정 전환 중 RPC 실패를 검증한다. UID home과 유효한 지연 이벤트의 경로를 지우면 안 된다.
3. 실제 Cloudflare 설치·Stream→Catalog→SQL 통합, 1천만/6천만 행의 계획·스캔량·지연, 120건/초 burst와 지역별 배정 지연을 측정한다.
4. 위 경계와 측정이 끝나기 전에는 운영 준비 완료나 전체 요구사항 완료로 표시하지 않는다. 60일 이전 분석 데이터 삭제·백업 정책은 사용자의 결정대로 이번 범위 밖이다.
