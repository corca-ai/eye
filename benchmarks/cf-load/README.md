# Cloudflare remote load test

Use `cf` 1.0.0-beta.20 and k6 2.3.0. Install the harness dependencies with `npm ci` in this directory. The root library source is bundled directly so the tested candidate is explicit. Builds use the Cloudflare Vite plugin 2 beta and no Wrangler invocation.

`eye/` is the private Eye Worker with SQLite DOs, event and dead-letter Queues and a Stream binding. `site/` is an authenticated synthetic host with a per-session DO. Both baseline and Eye requests await the same session read. Eye adds local `decide`, actual exposure records, page logs and occasional signed-value goals. Background preparations persist tokens to the session DO. Policies are the only cross-request SDK cache.

Configuration uses `CLOUDFLARE_ACCOUNT_ID` and optional `EYE_LOAD_PREFIX`. Resources and credentials stay in ignored `.state/`; generated output stays in `.cloudflare/`. Use `cf deploy --dry-run` in each Worker directory to validate builds without credentials. Provision account resources first, then deploy Eye and the site using `cf deploy --secrets-file ...`.

`run.mjs` expects `.state/deployment.json` with `url`, and `.state/site-secrets.json` with `TEST_TOKEN`/`EYE_DECISION_SECRET`. Run `node run.mjs` after deployment. It registers an isolated site, warms 400 sessions, then pairs baseline/Eye at 10/100/200 requests per second for five minutes each and runs Eye at 200 requests per second for fifteen minutes. Each k6 iteration makes exactly one HTTP request. An error threshold or dropped iteration stops subsequent stages. Results and logs are saved per run under ignored `results/`.

The workload uses three experiments with three arms each. `checkout` uses normal defaults (7-day observations); `hero` and `pricing` use 2-minute observations to exercise completion/reassignment. Goal draws and new-user draws are independently hashed to avoid tying conversion rates to cold sessions. Returning sessions are 50% uid and 50% anonymous. New sessions are 5% of requests, so total skipped decisions cannot be expected to meet a 1% target; inspect returning and new cohorts separately. Login transfer is checked in the functional smoke phase rather than counted as steady-state traffic.

Measure external p50/p95/p99 and TTFB, session and local Eye durations, outcome/reason counts, accepted/rejected events, queue backlog/retry/dead letters, pipeline visibility and final unique-event counts. Current sender output stores aggregate submissions rather than every successful event ID, so equal totals do not establish exact per-event delivery in the presence of HTTP failures. Worker performance timers advance after I/O; do not interpret a zero local duration as zero CPU cost. Cloudflare execution wall time includes waitUntil and is not response latency. Compare baseline/Eye distributions within the same load level rather than subtracting per-request quantiles as if paired samples.

After load, observe backlog and reports for at least five minutes and until the backlog stabilizes. Preserve run IDs and sender counts for exact eventual event reconciliation. A local single-region generator does not establish global latency, sustained production capacity, long-term MAB quality or a full monthly cost. Short observation settings make this workload unsuitable as a direct estimate for the default configuration's write cost.

`provision.mjs` creates only the named test resources, checkpoints successful steps, creates a 24-hour analytics token, and deploys both Workers. Run with `CLOUDFLARE_ACCOUNT_ID` set. A failed resource-creation response requires inspecting the remote state before retrying. `monitor.mjs` records best-effort Queue/DLQ metrics every 30 seconds and preserves API failures as errors. `server-metrics.mjs` uses GraphQL to collect namespace-scoped SQL/CPU/duration counters; namespace IDs are supplied in `.state/namespaces.json`. Raw GraphQL responses must be checked for `errors` and sampling/attribution limitations.

The first remote run stopped at 10 RPS because even the session baseline suffered storage timeouts. See the dated load-test report in `docs/` for results and whether later stages actually ran. `EYE_LOAD_SITE=SITE_ID EYE_LOAD_POOL=POOL_ID node stage.mjs eye 10 5m` can run an individual diagnostic stage after setup; the two variables are required and have no historical defaults; a k6 threshold failure is retained as exit code 99. Resuming a warmed run requires the same `EYE_LOAD_SITE` and `EYE_LOAD_POOL`; setting only the site in the full runner creates a fresh session pool. Every invocation and stage uses unique event and new-session IDs even when resuming the same site and pool; returning-session IDs intentionally stay stable.


`probe/` deploys a separate Worker with no Eye, Queue or Pipeline bindings. `probe-run.mjs` compares no DO, memory-only RPC, KV and SQL probes at 10 RPS for 30 seconds each. This short sequential probe cannot isolate global platform reliability or rank storage implementations.

For a host path without foreground session RPC, run `client-proxy.mjs` then `validate-fast.mjs`. The load-generator proxy holds signed tokens and sends separate background `/prepare` HTTP requests with at most four concurrent preparations. It stores its URL in ignored `.state/proxy.json`; stop the proxy after measurement. `/fast-page` itself reads supplied tokens without querying the host session DO. The fast validator uses new long-window experiments, 400 returning session IDs, 5% new sessions, 2-minute warmup, 1-minute baseline, and Eye at 10/100/200 RPS for 2/1/1 minutes. Preparation may not finish during warmup. The HTTP gate does not enforce participation or steady Queue backlog: report those separately and do not treat HTTP success as capacity qualification. See `docs/DO-REVIEW-2026-10-23.md` for observed limitations.

`node prepare-bench.mjs LABEL` runs a focused cold/warm preparation benchmark against the deployed source: 24 sessions, three experiments, 50% uid, concurrency four, three rounds. It records per-request duration, HTTP status, and whether all three tokens were returned. It does not measure page latency or silently exclude timeouts. Use distinct before/after labels and preserve both raw result directories.

## 리소스 상태 (2026-10-23)

`eye-do-probe-20261023` 진단 Worker와 전용 DO 네임스페이스 3개는 진단 종료 후 삭제했다. probe 소스는 재현용으로 남겨 두며 다시 실행하려면 먼저 배포해야 한다. `eye-load-20261023`과 `eye-load-20261023-site`는 후속 지속 부하 검증을 위해 유지한다. `.state/`의 자격 증명과 `results/`의 원본 결과는 커밋하지 않는다.

## 고정 마감 학습 비교

현재 private Worker는 SiteControl/ExperimentObject 학습 DO, 운영자 조회용 ReportObject와 고정 결과용 COHORTS R2 binding을 쓴다. `npm run build`를 저장소 루트에서 실행한 뒤 `node cohort-bench.mjs LABEL --seed`로 과거 발생 fixture를 심고, 파일이 queryable해진 뒤 `node cohort-bench.mjs LABEL`로 측정한다. `.state/cohort-fixture.json`을 유지하면 전후 동일 사건을 비교한다. 5,165사건·300표본이며 일반 track, 0/음수 보상, 로그인과 다른 기기 구매를 포함한다. 실제 각 SQL과 Cloudflare metrics, 로컬 reducer와의 결과 비교를 `results/cohort-LABEL.json`에 기록한다. 오류 때에도 query metrics를 별도 error 파일로 남긴다.

fixture seed는 과거 골 등록 절차를 생략하는 벤치마크 전용 RPC다. public HTTP가 비활성인 private Worker에만 있고 호스트의 인증된 경로를 통해 접근한다. 설치 템플릿이나 운영 Worker에 이 entrypoint를 사용하지 않는다. 초기 스키마/수집 가시성 지연 중 실패한 측정을 성능 결과로 보고하지 않는다.

`node operator-bench.mjs`는 같은 fixture에 대해 동일 골 조회를 동시 등록하고 같은 작업을 공유하는지, 완료 결과 페이지와 캐시 재등록이 같은 결과를 쓰는지 검증한다. 외부 등록/완료 시간과 SQL 스캔량을 기록한다. 데이터 기준 시각과 작업 완료 시각은 구분하며 사용자 요청 경로 성능으로 해석하지 않는다.

## 파일 생성 간격 비교

격리된 `eye-i1-*` 환경에서 `node roll-provision.mjs`는 같은 Stream을 읽는 300초 events/identity sink를 `eye_roll300`에 만든다. 기존 60초 sink를 변경하지 않는다. `node roll-bench.mjs --seed`는 1분 간격 여섯 배치를 보내며 중간 재시도는 같은 ID를 재사용한다. 전송이 끝난 뒤 `node roll-bench.mjs`로 양쪽의 arm·신원별 수집 수를 비교하고, `node roll-snapshots.mjs`로 시험 구간 append 파일/레코드 수와 snapshot 이력 누락 여부를 확인한다. `node roll-learning.mjs`는 실제 LearningSource의 1000표본 분할과 보상 일치를 검사한다.

가시성이 아직 부족하면 조회 비교는 exit code 1이다. 다시 seed하지 말고 원래 fixture와 실행 중 전송 프로세스를 보존한 채 조회만 재시도한다. 파일 간격은 end-to-end 가시성 상한이 아니다. 비교용 Pipeline도 별도 처리·저장 비용이 발생하므로 최종 비용 모델에서 운영 Pipeline과 구분하며, 시험 종료 후 해당 Pipeline을 중단/정리한다.

## v2 상태를 유지하는 직접 요청 시험

`node stateful-run.mjs --smoke`로 먼저 짧은 검증을 실행한다. 이후 `node stateful-run.mjs`는 별도 사이트에 3실험 × 3arm, 최소 유지 1일·기본 관측 7일을 설정하고 1분 warmup 후 10/100/200 RPS 각각 baseline/Eye 5분씩 측정한다. 총 약 31분이다. 배포된 호스트에 최신 `/fast-page` 구현이 있어야 한다.

각 k6 VU는 반복 사용자 한 명의 서명 상태를 응답에서 받아 다음 요청에 전달한다. 별도 5% 신규 사용자는 상태를 재사용하지 않는다. 초기 VU 요청도 신규로 분류하며 익명/로그인 사용자와 arm별 지표를 분리한다. 이 시험은 로그인 전환·다중 기기 동시 상태 병합 시험은 아니다. `/fast-page`는 session DO를 기다리지 않으며 실제 노출 후 `eye.state()`의 로컬 서명을 포함한다. baseline도 같은 헤더 파싱과 8192바이트 응답을 사용하지만 Eye 상태 검증/서명은 생략한다. baseline에는 Eye 토큰 전송량이 없으므로 헤더 오버헤드를 포함한 전체 도입 비용 비교다.

`state_churn`은 유지 기간 중 배정이나 관측 표본이 바뀌면 실패한다. HTTP/이벤트 거부/누락된 iteration과 응답·상태 계약도 검사한다. 미참여율은 신규·반복·신원별로 보고하며 임의의 통과 기준으로 숨기지 않는다. 정책 cold start가 있는 최초 요청은 정상적으로 미참여할 수 있다. 외부 지연은 단일 지역 생성기에서 측정한 값이며 `eye_local_ms=0`은 CPU 사용 0을 뜻하지 않는다.

`results/stateful-*/manifest.json`에 사이트, phase별 시작/종료 시각과 종료 코드가 남는다. 오류 시 해당 결과와 실행 프로세스를 확인하고, 관찰 timeout만으로 새 부하를 중복 실행하지 않는다. 각 실행은 독립 사이트이므로 다시 실행하면 새 데이터가 생긴다. 생성기 로그/요약과 Cloudflare 계측의 시간 범위를 맞춰 비교한다. 원본 결과와 자격 증명은 커밋하지 않는다.

수집 반영 후 `node stateful-collection.mjs results/STATEFUL_RUN_DIRECTORY`는 종료된 Eye phase(실패 포함)의 제출 총계, 실험/arm별 노출, 익명/로그인별 노출을 Basin의 고유 사건 수와 대조한다. SQL 기능은 `cf sql query`가 지원하지 않는 Basin warehouse API를 사용한다. 불일치는 exit 1이며 새 전송 없이 같은 명령으로 가시성을 재확인한다. 실행 중에도 완료된 phase만 점검할 수 있으므로 `matching=true`만으로 전체 시험 완료를 주장하지 않는다. `fullRunFinished`와 manifest의 모든 phase 종료 코드·HTTP 오류율을 함께 확인한다. 이는 집계별 수집 품질 검사이며 전송 사건 ID 전체의 집합 동등성이나 arm×신원 교차 집계를 검증한 것은 아니다.

외부 지연의 시간 변동을 구분하는 보조 시험은 `node stateful-run.mjs --interleaved`다. 독립 사이트에서 200 RPS·5분30초를 실행하고 처음 30초는 Eye로 예열, 나머지 5분은 baseline/Eye를 독립 해시로 배분한다. 두 모드가 같은 사용자 상태 헤더와 8192바이트 응답을 쓰므로 헤더 증가까지 포함하는 순차 비교와 목적이 다르다. 측정 구간의 신규 사용자 비율은 0이다. 늦게 추가된 VU도 세 실험의 배정 상태를 먼저 확보한 뒤 측정에 포함한다. 양쪽 모드의 측정 요청이 실제로 있어야 하며 측정 중 Eye 미참여율이 1% 이상이면 실패한다. `--smoke`를 함께 쓰면 10 RPS·45초다. 주 시험과 동시에 실행하지 않고 `http_req_duration{mode:...,phase:measure}`와 `http_req_waiting`을 비교한다. 수집 품질 대조를 대신하는 시험은 아니다.

`node server-metrics.mjs SINCE_ISO UNTIL_ISO OUTPUT_JSON`은 같은 시간 범위의 Workers/DO, Queue 과금 작업·재시도, Pipeline 입출력·sink·스키마 오류를 저장한다. 인자를 생략하면 시작은 1시간 전, 종료는 현재, 출력은 `results/server-metrics-latest.json`이다. GraphQL 오류는 저장한 뒤 실패로 종료한다. CLI에 해당 GraphQL 기능이 없어 공식 API를 사용한다. Adaptive 데이터의 집계·샘플링과 전달 경계 차이가 있으므로 송신 건수와 완전히 일치하는 원장으로 취급하지 않는다. sink 반영은 전송 구간보다 늦을 수 있어 반영 이후 구간도 확인하고, 다른 시험이 섞인 구간을 단일 phase의 비용으로 표시하지 않는다.

`node policy-bench.mjs`는 전용 사이트에서 실제 정책 RPC와 SDK decision runtime을 연결해 cold 미참여, 중지된 arm의 SWR 갱신, 정책 조회 실패 시 hard expiry 미참여를 검사한다. 시험에만 fresh 250ms·최대 나이 8초를 적용하고 동일 요청의 한 isolate에서 진행한다. 최초 실제 노출 표본을 연 뒤 최소 유지 1일인 arm을 중지해도 갱신 후 전환되는지 확인한다. 조회 실패는 정책 adapter에서 주입하며 Cloudflare 장애를 발생시키지 않는다. 종료 시 시험 실험을 일시중지한다. 이 측정은 기본 15분/6시간 설정의 경과 시간을 실제로 기다린 시험이나 전 세계 isolate 전파 SLA가 아니다.

HTTP 전송 실패는 `http_req_failed < 1%`로 검사하고, 수신한 HTTP 200 응답의 JSON·상태 계약은 100% 통과해야 한다. 허용된 전송 실패도 오류 건수와 지연 분포에 남기며 성공 응답으로 바꾸지 않는다. 전송 실패가 있으면 제출 총계는 응답을 받은 요청만 포함하므로 서버 저장 건수와의 차이를 그 사실과 함께 조사한다. `node stateful-run.mjs --rate 200 --eye-only`는 새 사이트에서 1분 예열 뒤 해당 Eye 단계만 5분 재검증한다. 이전 실패 결과를 덮어쓰거나 새 baseline을 실행한 것으로 표시하지 않는다.


`node drain-bench.mjs`는 기존 `.state/cohort-fixture.json`의 전용 cohort 사이트를 사용한다. 원본이 reducer와 일치하게 조회되는지 먼저 확인하고, 같은 설정의 3실험을 등록한 뒤 테스트용 hook으로 최초 한 번만 과거 학습 커서를 설정한다. 실제 `SiteControl.alarm()`이 시간 구간을 처리하도록 기다려 커서 전진·관찰된 오류·정상 다음 alarm과 arm별 감쇠 평균 및 가중치를 검사한다. 오류 카운터는 성공 시 지워지므로 폴링 사이에 발생하고 복구된 오류까지 없었다고 증명하지는 않는다. 3분 관찰 기한을 넘겨도 서버 작업을 초기화하지 않으며 재실행은 기존 커서를 관찰한다. `reusedInitialization=true`이면 새 적체를 처음부터 처리한 소요 시간으로 해석하지 않는다. 이 fixture는 300표본이며 원격 장애/대용량 적체의 SLA 검증은 아니다. 프로덕션 Worker에는 이 hook이 없다. 요청 지연 부하와 동시에 실행하지 않는다.
