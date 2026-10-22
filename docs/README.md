# 문서 안내

처음 연동한다면 [프로젝트 README](../README.md)와 [호스트 예제](../examples/host.ts)부터 읽는다. 이 프로젝트는 개발 중이며 실제 Cloudflare 운영 환경에서의 검증은 남아 있다.

| 문서 | 내용 |
| --- | --- |
| [요구사항](../DESIGN.md) | 합의한 동작, 제품 범위와 보상·신원 규칙 |
| [기술 설계](../TECHNICAL_DESIGN.md) | 상태 모델, 선택 정책, 저장소와 이벤트 전달 |
| [분석 API](ANALYTICS.md) | 조회·필터·집계 계약과 해석상의 한계 |
| [구현 상태](IMPLEMENTATION.md) | 현재 구현, 검증 증거와 남은 작업 |
| [코드 점검](REVIEW-2026-10-23.md) | 재현한 결함, 수정 내역과 남은 설계 차이 |
| [시뮬레이션](SIMULATION.md) | 장기 비정상 환경에서의 정책 비교와 원본 결과 |

구현 여부는 설계 문서만으로 판단하지 않고 구현 상태를 함께 확인한다. 특히 기존 uid에 없는 실험의 cid 상태 인계와 실제 Cloudflare 통합·성능 검증은 미완료다.

## 저장소 개발

Node.js 22 이상과 npm을 사용한다. 루트에서 `npm ci` 후 `npm run check`와 `npm run check:package`를 실행한다. 두 명령은 실제 Cloudflare 리소스를 배포하지 않는다.

- `src/`: 공개 API, 정책 계산, Durable Objects와 분석 처리.
- `test/`: 순수 로직 및 로컬 workerd 통합 검사.
- `templates/`: 고객 계정에 설치할 Worker와 provisioning 구성.
- `scripts/`: 설치 CLI, 타입 생성, 패키지 검증과 시뮬레이션.

`worker-configuration.d.ts`와 `src/runtime/environment.generated.ts`는 재현 가능한 타입 검사를 위해 버전 관리한다. 바인딩을 변경하면 `npm run types`로 함께 갱신한다. 루트 Wrangler 설정의 Stream ID는 로컬 검사용 placeholder다. 실제 설치 설정은 `eye init`으로 별도 디렉터리에 생성한다.

자격 증명은 환경 변수나 Cloudflare secrets로 공급한다. `.env*`, `.dev.vars*`, `.wrangler/`와 빌드 산출물은 버전 관리에서 제외한다. 실제 계정용으로 생성한 설치 디렉터리는 이 소스 저장소 밖에 둔다.
