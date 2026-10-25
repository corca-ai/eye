# 원자적 학습

[구현 구조](../TECHNICAL_DESIGN.md) · [검증 범위](IMPLEMENTATION.md)

SiteControl 한 곳에서 표본 마감, 세대·arm별 감쇠 통계 갱신, 선택적 요약, 분석 출력 outbox 생성을 같은 SQLite 트랜잭션으로 처리한다. 실험 정의·정책도 이 저장소에 둔다. 동기 ExperimentState가 실험 상태를 읽고 갱신하며 외부 I/O는 트랜잭션 밖에서 수행한다.

## 통계와 실패 처리

통계는 관측 종료부터 마감 기준 시각까지 감쇠한다. 동일 세대의 두 모멘트를 같은 시각으로 감쇠한 뒤 병합해 평균·분산·가중치를 구한다. 설정 변경은 새 generation으로 분리하고, arm 중지·재개·추가는 같은 세대의 증거를 유지한다.

SQLite 오류가 나면 표본 제거와 통계·요약·outbox가 함께 되돌아간다. 커밋 후 Stream 전송에 실패하면 outbox만 재전송한다. 통계를 재적용하지 않으므로 통계 전달 RPC나 cohort 중복 원장이 필요하지 않다. outbox에는 분석 출력만 보관한다. Stream 전송 자체는 최소 한 번이며 분석에서 ID 기반 중복 제거를 수행한다. 정책 발행도 같은 저장소에 outbox를 남기고 alarm이 전달한다.

정책은 설정 revision과 학습 dirty 상태로 무효화하고 감쇠·탐색을 위해 주기적으로 재평가한다. statsAsOf는 실제 적용한 마감 통계 시각이며 정책 재발행으로 덮어쓰지 않는다.

사이트별로 수집·귀속·정책 계산을 직렬화하므로 실험/arm과 관리·정책 요청이 많으면 수집과 경합할 수 있다. 실제 사이트에서 CPU·alarm 지연·대기 시간을 확인한다. 사이트 간에는 별도 객체이며 요청의 캐시된 decide는 원격 I/O를 기다리지 않는다.

## 검증

`test/runtime/atomic-learning.test.ts`와 `test/runtime/learning.test.ts`는 SQL 오류의 전체 롤백, Stream 실패 후 outbox 재시도, eviction 뒤 중복 학습 방지와 20개 동시 배치의 500개 무보상 표본 마감을 검사한다. 여러 실험의 보상 분할과 세대별 증거 분리도 설정·arm 변경 및 eviction을 거쳐 확인한다. `test/runtime/actors.test.ts`는 arm 상태 변경의 증거 보존과 정책 캐시·dirty·감쇠 재평가를 검사한다. A/A·A/B·우세 전환과 기준 보상 대조는 [로그 스트림 검증](ENGINE-VALIDATION.md)을 따른다.

전체 검사는 `npm run check`, 패키지 소비자·설치 번들은 `npm run check:package`다. 동시 수집 검사는 처리량 벤치마크가 아니며 실제 Cloudflare 지연·비용은 별도 측정해야 한다.
