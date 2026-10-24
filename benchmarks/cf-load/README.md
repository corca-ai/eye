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
