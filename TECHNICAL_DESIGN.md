# 구현 구조

[요구사항](DESIGN.md) · [연동](docs/INTEGRATION.md) · [검증 범위](docs/IMPLEMENTATION.md)

## 요청 경로

호스트 SDK는 isolate의 정책 캐시와 호스트가 보관한 서명 문맥으로 선택한다. `decide()`는 네트워크를 기다리지 않는다. 서명 검증·서명 생성은 로컬 비동기 암호 연산이다. 정책은 기본 60초 후 백그라운드 갱신하고 발행 후 5분까지 재사용한다. cold/만료는 미참여로 반환하며 정책만 준비한다. `prepare()`는 정책 RPC를 기다리는 명시적 API다.

문맥에는 원래 subject, assignment, 선택 당시 설정·확률, 첫 실제 노출의 sample이 있다. 서버 세션 또는 응답 쿠키로 보관한다. 배정과 실제 노출이 문맥을 바꾸면 `onPrepared`가 호출된다. 쿠키 방식은 `state()`로 로컬 서명을 기다린 후 응답에 쓴다. 저장 실패·동시 요청·다른 기기 사이의 완전한 일관성은 보장하지 않는다.

일반 재선택은 최소 유지 기간과 현재 관측 종료를 모두 기다린다. 장기 유지 중 관측이 끝나면 다음 실제 노출부터 새로운 표본을 연다. uid 변경, 비활성 arm/실험은 정책 반영 후 유지보다 우선한다. 미노출 배정은 학습 표본을 만들지 않는다.

## 수집과 저장

`track/goal/expose/identify/logout → waitUntil → Queue → Stream → Catalog tables`가 원본 전달 경로다. 한 배치에서 원본과 분석용 projection을 함께 보낸다. 재시도는 같은 record ID를 사용하고 조회 시 중복 제거한다. Queue goal 배치만 SiteControl에서 발생 당시 골 상태를 조회한다. 수집 과정에 사용자별 DO나 학습 상태 쓰기는 없다.

Stream fan-out은 events, observations, credits, decisions, identity_links, policies, attribute_keys 일곱 테이블을 쓴다. decisions는 실제 노출된 배정만 포함한다. observations는 최초 노출의 pending 행과 마감 후 complete 행이다. credits의 저장 행은 확정 학습의 근거이며, 공개 분석 API의 귀속 보상은 원본에서 다시 계산한다. 테이블 간 가시성은 원자적이지 않다.

## 학습

두 SQLite Durable Object만 사용한다.

- SiteControl: 골 상태 이력, 실험 목록, 학습 커서·설정 상한. 시간당 마감 구간을 alarm으로 처리한다.
- ExperimentObject: 실험 정의, arm별 감쇠 통계, 적용한 cohort ID, 정책 발행 outbox. 사용자별 배정·관측·정정 원장이 없다.

첫 실제 노출 시각 t, 관측 기간 W, 수집 유예 G이면 마감 대상 시각은 t+W+G다. 시간 단위 구간 안의 표본을 sample ID 순서로 최대 50개씩 읽고, 관련 신원·노출·골을 조회해 메모리에서 축약한다. uid 또는 첫 로그인으로 연결된 cid를 함께 조회하며, 분배 분모에는 현재 페이지 밖의 실험도 포함한다.

처음 성공한 조회 결과를 R2 `eye/cohorts/`에 조건부 생성하여 고정한다. 이후 실험 통계 적용 → 분석 결과 전송 → durable cursor 전진 → R2 결과 삭제 순서다. 실패하면 같은 결과를 재사용한다. 실험별 cohort ID로 통계 재적용을 막는다. 원본 입력 전체나 사용자 원장을 영속화하지 않는다. R2 저장 전 실패한 조회는 다시 수행할 수 있다.

마감 시 조회 가능했던 데이터로 한 번 확정한다. 이후 도착한 데이터는 원본 분석을 바꾸지만 학습을 정정하지 않는다. 분할 페이지가 동일한 전역 스냅샷을 공유한다는 보장은 없다. `statsAsOf`도 수신 완료 watermark가 아니다.

## 운영 한계

원본 조회 범위는 최근 60일이다. 사이트의 과거 최대 W + 최대 G + 최대 귀속 기간은 60일에서 1시간을 뺀 값보다 작아야 한다. 설정을 줄여도 과거 최대치는 유지한다. 이는 과거 설정의 문맥을 계속 해석하기 위한 보수적 제한이다.

한 페이지 입력은 10,000행, SQL 응답/고정 결과는 16 MiB로 제한한다. 조회 실패 시 표본 수를 50→25→…→1로 줄인다. 한 표본의 관련 사건만으로도 한도를 넘으면 오류와 재시도가 계속되어 해당 사이트 학습이 지연될 수 있다. 조용히 잘라서 학습하지 않는다. 대량 활동 계정·봇·공유 uid는 도입 전에 점검한다. 60일 이상 뒤처진 커서는 경고와 함께 보존 범위로 이동한다.

R2 결과는 정상 완료 후 삭제한다. cursor 전진 직후 장애로 남은 결과는 orphan이 될 수 있으므로 필요하면 해당 prefix에 충분한 유예를 둔 lifecycle을 운영자가 설정한다. 활성 재시도 결과를 지우는 짧은 lifecycle은 피한다. 60일은 API 조회 계약이며 설치 스크립트는 물리적 데이터 삭제 정책을 자동 설치하지 않는다.

새 설정은 새 generation을 만든다. 기존 배정·관측은 원래 설정으로 끝나고 현 정책은 새 generation 통계를 사용한다. arm 추가·중지·재개는 generation을 바꾸지 않는다. 따라서 장기 실험에서 arm만 바꾸면 최근 학습을 유지한다.

## 배포 호환성

현재 템플릿의 `v2-fresh`는 신규 설치 전용이다. 기존 v1 Worker에 migration 목록을 그대로 덮어쓰지 않는다. 사용자별 DO 제거와 토큰 형식 변경은 호환 변경이 아니다. 기존 설치는 새 Eye Worker/namespace를 설치하고 호스트 연결과 저장 토큰을 전환하는 방식으로 검증한다. 이 변경은 원격 리소스를 자동 삭제하거나 이전 데이터를 자동 이관하지 않는다.

Cloudflare 참고: [DO SQLite](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [Basin SQL](https://developers.cloudflare.com/basin-sql/), [Pipelines](https://developers.cloudflare.com/pipelines/). 로컬 SQL 호환 테스트는 실제 Basin 실행 계획·비용·처리량 검증을 대신하지 않는다.
