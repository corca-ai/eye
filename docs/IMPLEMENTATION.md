# 구현 및 검증 범위

[문서 안내](README.md) · [설계](../DESIGN.md) · [구현 구조](../TECHNICAL_DESIGN.md)

현재 구현은 로컬 배정, 서버 요청 래퍼, CSR 클라이언트/서버 어댑터, Queue 원본 수집, Queue 배치 내 정렬과 SQLite 증분 학습, 두 Durable Object의 정책 관리, SQLite outbox 재시도, 원본 분석 API와 ReportObject의 비동기 조회·결과 재사용까지 연결한다. 이전 사용자별 Subject/Identity/Shard 객체와 예약·보상 정정 경로는 제거했다.

로컬 검증은 TypeScript, 순수 코어 테스트, workerd의 DO/Queue 테스트, 생성 SQL의 SQLite 호환 실행, 패키지 외부 소비자 및 DOM 전용 브라우저 타입 검사, 신규 설치 Worker 번들 dry-run을 사용한다. 실제 노출→원본→학습→정책, 트랜잭션 롤백·재전송·eviction 중 중복 학습 방지, 로그인 귀속, 음수/큰 보상, 늦은 사건과 확정 보상 차이, CSR 인증 전환과 준비/노출 경합을 검사한다.

로컬 비교는 `benchmarks/local-learning/run.mjs`로 재현한다. 메모리 SQLite·고정 인공 입력의 결과이며 Basin의 스캔량, 네트워크·디스크 영속화 비용, 운영 처리량을 뜻하지 않는다. 기존 조회 기반 구조의 원격 측정은 [이전 기록](ISSUE-1-PERFORMANCE.md)에 있다. 새 증분 학습 구조의 원격 부하·실제 쓰기 비용은 아직 검증하지 않았다. SQLite 호환 실행은 Cloudflare 프로덕션 쿼리 실행을 대신하지 않는다. 과거 부하/비용 문서는 v1의 기록이며 이 구현의 성능이나 절감률로 인용하지 않는다. 하루 100만 사건은 설계 가정이지 검증된 처리량이 아니다.

도입 전에는 신규 테스트 Worker에 설치하여 Stream fan-out, Basin 쿼리, alarm 마감, 이후 정책 반영을 실제로 확인하고, 기존 기본 화면 대비 지연·미참여율·arm별 수집 유실을 측정한다. 학습용 원본 조회는 제거했지만 사이트별 SQLite 쓰기·outbox 지연과 대량 활동 uid는 측정한다. 구체적인 한도와 배포 전환은 구현 구조 문서를 따른다.

이 버전의 템플릿은 신규 설치용이다. 기존 v1 배포/데이터의 자동 마이그레이션 및 삭제는 구현하지 않으며, 코드 수정만으로 원격 리소스를 변경하지 않는다.

## 수집 파일과 운영 로그 기본값

신규 설치의 sink 파일 생성 간격은 300초다. 설치 전 `resources.json`의 `sinkRollIntervalSeconds`를 60~300초 정수로 조정할 수 있다. 이 필드가 없는 기존 생성 디렉터리는 60초를 유지한다. 리소스 생성 이후 설정 파일을 편집하거나 코드만 배포해도 기존 sink가 변경되지는 않는다. provision 체크포인트는 기존 구성을 자동으로 재작성하지 않는다.

300초는 파일 생성 간격이며 Queue·Stream·Catalog를 합친 분석 가시성 보장 시간이 아니다. 증분 학습은 Queue 수신 상태를 사용하므로 sink 파일 가시성을 기다리지 않는다. 관측 종료 후 수신 유예와 파일 생성 간격은 별개다. [Cloudflare sink 설정](https://developers.cloudflare.com/basin-pipelines/sinks/available-sinks/r2-data-catalog/)을 따른다.

Eye Worker의 자동 invocation 로그는 끄고 명시적 진단 로그와 head sampling 1은 유지한다. RPC·Queue·alarm 호출마다 기본 로그 한 건을 보관하는 비용을 줄이며 원본 웹로그에는 영향을 주지 않는다. 호출별 진단이 필요할 때 `observability.logs.invocation_logs`를 켜고 재배포한다. [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)의 invocation 로그와 사용자 console 로그는 별도 설정이다.

기존 테스트 sink를 변경하거나 삭제하지 않고 같은 Stream을 읽는 300초 병렬 sink를 만드는 도구는 `benchmarks/cf-load/roll-provision.mjs`다. 이 도구는 격리된 issue-1 테스트 환경 전용이며, 병렬 Pipeline 자체의 추가 시험 비용은 운영 비용 추정과 구분한다.
