# 문서 안내

## 사이트 연동

처음에는 **[연동 가이드](INTEGRATION.md)** 한 문서를 순서대로 읽는다. API를 찾을 때는 생성 레퍼런스, 동작을 깊게 확인할 때는 아래 계약 문서를 사용한다.

| 문서 | 용도 |
| --- | --- |
| [CSR·SPA 연동](CSR.md) | 브라우저 동기 선택·뷰 수명·암호화 노출 증표·수신 경로 |
| [서비스 코드 구성](APPLICATION-INTEGRATION.md) | 요청 래퍼·fallback, 실제 세션/쿠키 연동, 업무 사건과 SPA 경계 |
| [연동 가이드](INTEGRATION.md) | 설치부터 첫 실험·골·결과 확인, 오류 처리와 문제 해결 |
| [SDK API](api/client.md) | 소스에서 생성한 함수별 입력·반환값과 동작 설명 |
| [타입과 파라미터](api/types.md) | 소스에서 생성한 설정 기본값·제약과 데이터 타입 |
| [호스트 예제](../examples/host.ts) | 패키지 검사에서 타입 검증하는 실제 핸들러 |
| [빠른 배정](FAST-DECISIONS.md) | 세션 토큰, SWR, 준비·미참여·유지 기간의 상세 계약 |
| [분석 가이드](ANALYTICS.md) | 사용자군 비교·필터·시계열·타임라인과 응답 해석 |
| [설치 템플릿](../templates/README.md) | 계정 리소스 구성, 토큰, 설치 재시도와 업데이트 |

## 설계와 운영 근거

| 문서 | 용도 |
| --- | --- |
| [구현 상태](IMPLEMENTATION.md) | 구현 범위·검증 증거와 남은 운영 검증 |
| [요구사항](../DESIGN.md) | 제품 범위와 보상·신원 규칙, 합의 기록 |
| [기술 설계](../TECHNICAL_DESIGN.md) | 내부 상태·선택 알고리즘·저장소 구조 |
| [현재 비용 모델](COST-V2.md) | v2 비용 항목·가정별 총액·실측 범위 |
| [과거 비용 기록](COST.md) | v1 사용량 가정과 비용 기록 |
| [실배포 부하테스트](LOAD-TEST-2026-10-23.md) | v1 실제 계정의 측정 조건·실패와 제한 |
| [DO 동작 점검](DO-REVIEW-2026-10-23.md) | 저장 gate·알람·배경 발행 수정과 독립 프로브·재측정 |
| [최적화 검증](PERFORMANCE.md) | v1 수집 경로·SQLite 쓰기 측정 |
| [시뮬레이션](SIMULATION.md) | v1 정책의 장기 비정상 환경 비교 |

다음은 과거 검토 기록이며 현재 연동 절차로 사용하지 않는다: [요청 경로 계획](REQUEST-PATH-PLAN.md), [문서·구현 대조](DOC-CODE-AUDIT.md), [코드 점검](REVIEW-2026-10-23.md).

## 문서 유지보수

API 설명은 `src/`의 JSDoc, 함수 시그니처와 타입을 원본으로 한다. `npm run docs:api`로 `docs/api/`를 갱신하고 `npm run docs:check`로 최신성을 검사한다. 생성 문서는 커밋·패키지에 포함하므로 별도 문서 서버 없이 읽을 수 있다. 호출 순서·업무 예제는 연동 가이드, 집계 의미는 분석 가이드에만 상세히 둔다.

저장소 검사 명령은 [README](../README.md#개발과-문서-갱신)에 있다. `src/`는 SDK·런타임, `test/`는 순수 로직·workerd 검사, `templates/`는 계정 설치 구성, `scripts/`는 도구다. 루트 Wrangler Stream ID는 로컬 검사용 placeholder이며 실제 설정은 `eye init`으로 만든다. 자격 증명은 환경 변수·secrets로 공급하고 실제 계정 설치 디렉터리는 소스 저장소 밖에 둔다.

- [SDK 반복 작업 최적화 평가](PERFORMANCE-SDK.md): 서명·준비 RPC·수집 묶음의 전후 측정과 학습 페이지 크기 비교.
