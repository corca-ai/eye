# 구현 및 검증 범위

[문서 안내](README.md) · [설계](../DESIGN.md) · [구현 구조](../TECHNICAL_DESIGN.md)

Eye는 서버·브라우저 SDK의 로컬 배정과 실제 노출, Queue 수집, SiteControl SQLite
증분 학습과 집계를 제공한다. 집계는 목표별 확정 시간 집계, 실험별 성과와 정책
이력, 명시적으로 설정하는 기본 요약을 포함한다.

`npm run check`는 빌드·타입·코어 및 workerd 테스트·생성 문서를 확인한다.
가입 전 배정의 로그인 후 귀속, 큐 재시도, SQL 오류 시 마감 롤백, 음수 보상,
객체 재시작과 동시 수집을 검증한다. `npm run test:engine`은 고정 시드에서
A/A, A/B, 우세 전환과 독립 코호트 리듀서 결과를 비교한다.
[로그 스트림 검증](ENGINE-VALIDATION.md)에 검증 범위가 있다.

`npm run check:package`는 외부 SDK 소비자, 브라우저 타입과 생성된 설치의
Worker 번들을 검증한다. 실제 Cloudflare 부하, 지연 및 운영 처리량을
측정하려면 별도의 설치에서 합성 노출과 골로 검증한다.
