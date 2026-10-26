# Eye for Cloudflare Workers

서비스 소유의 Cloudflare 인프라에서 동작하는 웹로그 분석 및 지속형 MAB 라이브러리다. 서비스가 실제 노출과 goal 발생·가치를 전달하며, 모든 실험은 같은 Eye 설치의 goal value를 학습한다. uid 우선 선택과 로그인 이력 귀속, 시간 감쇠 학습, 음수 골, 실험·arm 추가·중지·삭제를 지원한다.

서버 요청 래퍼와 CSR 브라우저 SDK, 관리·분석 API를 제공한다. 서비스가 실제 표시·업무 사건과 UI를 연결하면 Eye가 배정·수집·학습을 처리한다. 배정은 로컬 정책을 사용하고 학습은 수신 사건을 증분 처리한다. 검증 범위는 [구현 상태](docs/IMPLEMENTATION.md), 비용 측정은 [최신 로컬 비교](docs/INCREMENTAL-COST.md)를 참고한다.

## 연동하기

[연동 가이드](docs/INTEGRATION.md)를 순서대로 따라가면 설치 → 골·실험 등록 → 세션 연결 → 실제 노출·골 수집 → 결과 조회까지 진행할 수 있다. 아직 npm에 게시하지 않았으므로 저장소에서 tarball을 만들어 설치한다.

| 하려는 일 | 시작점 | 문서 |
| --- | --- | --- |
| 처음 설치하고 골·실험 등록 | `createEye` | [연동 가이드](docs/INTEGRATION.md) |
| 서버 페이지 선택·노출·업무 사건 | 요청마다 `createEyeRequest` | [서비스 코드 구성](docs/APPLICATION-INTEGRATION.md) · [호스트 예제](examples/host.ts) |
| CSR·SPA의 실제 표시 연결 | 브라우저 `createEyeBrowser` + 서버 `createEyeBrowserServer` | [브라우저 연동](docs/CSR.md) |
| 관리·분석·명시적 배정 준비 | `createEye` | [API 레퍼런스](docs/api/client.md) · [분석 해석](docs/ANALYTICS.md) |
| 타입·기본값·제약 확인 | 각 타입의 임포트 경로와 JSDoc | [타입 레퍼런스](docs/api/types.md) |
| 세션·캐시·미참여 처리 | 서명 토큰과 `DecisionCache` | [빠른 배정](docs/FAST-DECISIONS.md) |
| 설계·비용·검증 확인 | 현재 구현과 과거 기록 구분 | [전체 문서 안내](docs/README.md) |

브라우저 클라이언트는 `@eye/workers/browser`, 서버 SDK는 `@eye/workers`에서 가져온다. `@eye/workers/worker`는 설치 템플릿의 Worker 배포 진입점이다.

선택과 실제 노출은 별개다. 준비가 안 됐으면 fallback을 사용하고 노출을 기록하지 않는다. 선택한 화면을 실제 제공한 뒤 `expose()`를 호출한다. 서버 수집은 `waitUntil()`에서 전송하며 로컬 `accepted`가 저장·학습 완료를 뜻하지 않는다. [신원·세션 연결](docs/INTEGRATION.md#3-ciduid와-서버-세션-연결)을 먼저 확인한다.

## 개발과 문서 갱신

Node.js 22 이상에서 실행한다.

```sh
npm ci
npm run check
npm run check:package
```

`check`는 타입·테스트·빌드와 생성 문서의 최신성을 확인한다. `check:package`는 외부 소비자 타입, 패키지 문서 링크, 설치 설정과 Worker 번들 dry-run을 검증한다. 실제 리소스는 배포하지 않는다. 바인딩 변경 시 `npm run types`로 타입을 갱신한다.

API 설명은 TypeScript 소스의 JSDoc에 작성하고 `npm run docs:api`로 생성한다. 생성 문서를 직접 수정하지 않는다. `npm run docs:check`는 공개 export·클라이언트 메서드의 설명 누락과 생성 문서의 최신성을 검사한다. 문서 생성은 안정된 컴파일러 API를 제공하는 별칭 의존성 `typescript-docs`(6.x)를 사용하며, 제품 빌드와 타입 검사는 기존 TypeScript 7을 유지한다.

## 라이선스

[MIT](LICENSE) © 2026 Corca, Inc.
