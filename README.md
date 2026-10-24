# Eye for Cloudflare Workers

서비스 소유의 Cloudflare 인프라에서 동작하는 웹로그 분석 및 지속형 MAB 라이브러리다. 서비스가 실제 노출과 goal 발생·가치를 전달하며, 모든 실험은 같은 사이트의 goal value를 학습한다. uid 우선 선택과 로그인 이력 귀속, 시간 감쇠 학습, 음수 골, 실험·arm 추가·중지·삭제를 지원한다.

서버 요청 래퍼와 CSR 브라우저 SDK, 관리·분석 API를 제공한다. 서비스는 실제 표시·업무 사건을 연결하고 UI를 만든다. 로컬 배정과 일괄 마감 학습으로 사용자별 중앙 원장을 제거했다. 원격 요청 부하·구간 학습·운영자 조회의 [측정 범위](docs/ISSUE-1-PERFORMANCE.md)와 [비용 모델](docs/COST-V2.md)을 제공한다. [구현 상태](docs/IMPLEMENTATION.md)를 확인한다.

## 연동하기

[연동 가이드](docs/INTEGRATION.md)를 순서대로 따라가면 설치 → 골·실험 등록 → 세션 연결 → 실제 노출·골 수집 → 결과 조회까지 진행할 수 있다. 아직 npm에 게시하지 않았으므로 저장소에서 tarball을 만들어 설치한다.

| 필요한 정보 | 문서 |
| --- | --- |
| CSR·SPA에 연결하기 | [브라우저 SDK와 서버 어댑터](docs/CSR.md) |
| 페이지 코드를 간단하게 유지하기 | [요청 래퍼·서비스 코드 구성](docs/APPLICATION-INTEGRATION.md) |
| 처음 사이트에 연결하기 | [연동 가이드](docs/INTEGRATION.md) · [호스트 코드 예제](examples/host.ts) |
| 함수의 입력·반환값 찾기 | [자동 생성 SDK API](docs/api/client.md) |
| 파라미터 의미·기본값·제약 찾기 | [자동 생성 타입 레퍼런스](docs/api/types.md) |
| 서버 세션·SWR·미참여 처리 | [빠른 배정](docs/FAST-DECISIONS.md) |
| 필터·응답 해석·사용자 추적 | [분석 가이드](docs/ANALYTICS.md) |
| 설계·비용·구현 상태 확인 | [전체 문서 안내](docs/README.md) |

배정에는 캐시된 정책과 보관된 로컬 문맥을 사용하는 `decide()`를 기본으로 쓴다. 원격 응답을 기다리지 않고, 미준비 요청은 기본 화면으로 처리한다. 수집은 요청의 `waitUntil()`에서 전달한다. 서버 세션과 서명 secret 설정을 포함한 [연동 절차](docs/INTEGRATION.md#3-ciduid와-서버-세션-연결)를 먼저 확인한다.

## 개발과 문서 갱신

Node.js 22 이상에서 실행한다.

```sh
npm ci
npm run check
npm run check:package
```

`check`는 타입·테스트·빌드와 생성 문서의 최신성을 확인한다. `check:package`는 외부 소비자 타입, 패키지 문서 링크, 설치 설정과 Worker 번들 dry-run을 검증한다. 실제 리소스는 배포하지 않는다. 바인딩 변경 시 `npm run types`로 타입을 갱신한다.

API 설명은 TypeScript 소스의 JSDoc에 작성하고 `npm run docs:api`로 생성한다. 생성 문서를 직접 수정하지 않는다. `npm run docs:check`는 변경이 반영되지 않았으면 실패한다. 문서 생성은 안정된 컴파일러 API를 제공하는 별칭 의존성 `typescript-docs`(6.x)를 사용하며, 제품 빌드와 타입 검사는 기존 TypeScript 7을 유지한다.

## 라이선스

[MIT](LICENSE) © 2026 Corca, Inc.
