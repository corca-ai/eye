# SDK 반복 작업 최적화 평가

기준 커밋은 5272223이다. 배포 없이 Node.js v24.22.1/macOS와 로컬 Workers 테스트로 검증했다. RPC 지연은 SDK 벤치마크에서 2ms 타이머로 모사했고 ingestion은 전달 사건과 Queue 메시지 수를 세는 로컬 구현이다. 아래 시간은 원격 Workers의 응답 시간이나 CPU 과금 측정치가 아니다.

## 적용한 변경

- 같은 관측 표본의 반복 노출은 모든 사건을 수집하되 배정 문맥을 재서명·저장하지 않는다. 새 배정과 새 관측은 계속 저장한다.
- prepare는 하드 만료 전 정책을 재사용한다. 신선도 기간을 지나면 SWR로 갱신하고, cold/하드 만료는 조회를 기다린다. forceRefresh=true는 명시적으로 조회하며, 일반 동시 조회는 같은 cache·site·experiment·maxAge에서 진행 중인 요청을 공유한다. 완료·실패 시 공유 항목은 제거한다. 공유 항목은 캐시별 최대 1000개이며 10초를 넘긴 조회는 새 요청이 다시 시작할 수 있다.
- SDK 수집은 다음 event-loop turn까지 같은 요청의 사건을 모은다. 사용자 응답에서 기다리지 않고 waitUntil로 수명을 유지한다. 명시적 flush와 100사건·바이트 기준 도달은 지연 없이 flush를 시작한다. 요청 간 버퍼나 새 DO는 추가하지 않는다.
- 학습 페이지 크기는 비교만 수행했고 기본 1000을 유지한다. 관측·귀속·원본 보관·학습 주기는 변경하지 않는다.

## 동일 workload 전후

워밍업 한 번 후 세 번 실행한 시간의 중앙값이다. 횟수는 각 실행의 결정적 계수다.

| 작업 | 이전 | 이후 |
|---|---:|---:|
| 동일 표본 노출 1000회: 상태 저장 콜백 | 1001회 | 2회 |
| 위 로컬 처리 시간 | 24.95ms | 0.38ms |
| 최초 준비 후 50회 준비: 추가 정책 RPC | 50회 | 0회 |
| 위 처리 시간, RPC당 2ms 모사 | 127.18ms | 0.077ms |
| 같은 실험의 동시 cold 준비 20건: 정책 RPC | 20회 | 1회 |
| 100요청 × microtask로 나뉜 5사건: ingest/Queue 메시지 | 500/500회 | 100/100회 |
| 위 workload의 수집 사건 | 500건 | 500건 |

노출 벤치마크는 decisionRuntime과 실제 로컬 HMAC을 사용한다. 수집·분석 전체 요청 시간의 98% 개선을 뜻하지 않는다. 준비 시간도 실제 네트워크 절감률로 일반화하지 않는다. 동일 표본당 반복 노출 횟수, 캐시 적중률, 요청 내 사건 간 비동기 I/O에 따라 운영 효과가 달라진다. 서로 다른 요청 또는 타이머/I/O 이후 사건은 항상 하나로 묶인다고 보장하지 않는다.

## 학습 페이지 실험

원본 노출 2001개와 골 5개(양수·음수), 0 보상 표본을 포함한다. 기존 SQL을 로컬 SQLite에서 실행하고 표본 ID·보상 전체가 페이지 크기별로 동일함을 확인했다. SQL 함수는 테스트용 JSON 함수 구현이며 Basin의 실행 계획·스캔 과금과 다르다. 시간은 세 번 실행의 중앙값이다.

| 페이지 한도 | SQL 호출 | 전체 처리 | 최대 고정 결과 JSON |
|---|---:|---:|---:|
| 1000 | 3 | 2078.50ms | 1,681,598 bytes |
| 2000 | 2 | 1401.76ms | 3,359,367 bytes |
| 5000 | 1 | 748.70ms | 3,361,094 bytes |

실제 표본은 2001개이므로 5000행 결과의 최대 메모리를 검증한 것이 아니다. 전송·JSON 파싱·DO 메모리의 비용과 실제 Basin 스캔량을 추가 비교하기 전까지 기본값은 올리지 않는다. 고밀도 골 fixture에서는 로컬 SQL 계산이 오래 걸려 중단했으며, 위 결과는 희소 골 workload에 한정된다.

## 비용 해석

Queue는 batch API 호출 수가 아니라 메시지별 64KB 단위 write/read/delete를 과금한다. 이 변경은 실제 메시지 수를 줄인다. 월 3000만 사건, 메시지 모두 64KB 이내, 재시도 없음, 포함량이 남았다고 가정하면:

- 메시지당 1→5사건: Queue 약 $35.60→$6.80/월.
- 기존 비용 모델의 2→5사건: Queue 약 $17.60→$6.80/월.

이는 운영 실측 견적이 아니라 동일 단가의 조건부 계산이다. Pipeline·R2 비용은 사건을 삭제하지 않으므로 같은 비율로 줄지 않는다. 상태 저장 비용은 호스트의 세션 저장소에 따라 달라지고, 정책 RPC가 줄어도 이미 포함량 안이면 청구 절감은 작을 수 있다.

공식 근거: [Queue 과금](https://developers.cloudflare.com/queues/platform/pricing/), [Basin SQL 과금](https://developers.cloudflare.com/basin-sql/platform/pricing/). 전체 비용 항목은 [비용 모델](COST-V2.md)을 따른다.

## 재현 및 검증

원시 측정: [results.json](measurements/sdk-results.json).

~~~sh
npm run build
node benchmarks/sdk/performance.mjs
# 기준 커밋을 별도 checkout에서 빌드한 dist를 인자로 주어 동일 스크립트로 비교
node benchmarks/sdk/performance.mjs /absolute/path/to/baseline/dist

node_modules/.bin/esbuild benchmarks/sdk/learning-pages.ts --bundle --platform=node --format=esm --outfile=/tmp/eye-learning-pages.mjs
node /tmp/eye-learning-pages.mjs

npm run check
npm run check:package
~~~

회귀 테스트는 반복 노출의 사건 유지, 새 관측 저장, 외부 문맥의 토큰 복원, 준비 중 노출 경합, 정책 하드 만료, 강제 조회, 동시 조회 실패 후 재시도, 자동 수집·명시적 flush·전송 실패를 다룬다.

최종 검증: 167개 테스트, 빌드·타입·API 문서 검사 및 외부 소비자 패키지 검증 통과.
