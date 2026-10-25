# Eye installation

This directory runs inside your existing Workers project, which must have `@eye/workers` and Wrangler 4.151.3 or later installed. All resources belong to the account in `wrangler.jsonc`.

Review `resources.json`, `wrangler.jsonc`, `schema.json`, and `fanout.sql`. Authenticate Wrangler with your account and set `EYE_CATALOG_TOKEN` and `EYE_ANALYTICS_TOKEN` in your shell or secret manager. The catalog token needs permission to create/write catalog tables; the query token needs the [Basin SQL permissions](https://developers.cloudflare.com/basin-sql/query-data/#authentication). Tokens are never stored in these project files. The catalog token is passed as an argument to Wrangler's sink command; use a trusted provisioning machine.

Run `node provision.mjs` from this directory. This explicitly creates one R2 bucket, enables Catalog, creates two Queues, one Stream, seven sinks, one fan-out pipeline, and deploys the private Eye Worker. It then uploads the query token as a Worker secret. It does not deploy or modify your application. Successful creation steps are recorded locally so a retry can continue. If Cloudflare created a resource but the command failed before acknowledgement, inspect that resource before retrying; the script does not adopt or delete arbitrary existing resources.

The initial Stream ID is a placeholder. Do not deploy this config before provisioning has replaced it. New installations roll files at 300 seconds. Before provisioning, set `sinkRollIntervalSeconds` in `resources.json` to an integer from 60 to 300 if a shorter delay is needed. Existing resource files without that field retain 60 seconds. Query visibility is eventual: the roll interval is not an end-to-end delivery bound. The default one-hour learning grace leaves room for this batching. If you choose a short `allowedLatenessMs`, measure Queue/Stream/Catalog visibility and select an appropriate roll interval before relying on learning results; data arriving after closure is not used to correct learning. No old-data deletion or archival rule is installed. Keep `.provision-state.json` to resume setup; back up resource configuration through your usual infrastructure process.

Add this binding to your application's Wrangler config (replace `eye` with the Worker name):

```json
{ "services": [{ "binding": "EYE", "service": "eye" }] }
```

Use `createEye({ service: env.EYE, ctx, siteId: "your-site" })` for each request. `EyeService` is the structural TypeScript type for `env.EYE`; regenerate application binding types with Wrangler. See the package README for tracking, actual exposure, goal and analysis examples. Register goals and experiments once through a trusted administrative path, rather than on each request. The Worker exposes RPC only; HTTP returns 404. Your service must authenticate and authorize any public administrative or analysis endpoints it chooses to build.

For later code-only updates, run `wrangler deploy --config wrangler.jsonc`. Changes to a Stream/table schema or pipeline need a reviewed migration; re-running the provision script is not a schema migration mechanism.

Fast `decide()` uses a local policy cache and signed per-device context; it requires a host `decisions.secret` (at least 32 UTF-8 bytes). Save updates from `onPrepared` in the host session, or await `state()` after exposure and save the result in response cookies. Cold/expired policy requests skip participation. `prepare()` explicitly waits for a policy RPC. There is no central assignment or `decideConsistent()` API.

Learning closes samples, updates experiment moments and creates its export outbox in one SiteControl SQLite transaction, without cross-object learning RPC, Basin queries or temporary R2 results. The COHORTS R2 binding remains for asynchronous report results under `eye/reports/`. ReportObject and the REPORTS binding coordinate operator jobs; the additive `v2-reports` migration must be deployed with them. Preserve existing v2 migration history. This config's `v2-fresh` migration is for a new installation only. Do not replace an existing v1 migration history with it. Install a new Worker/namespaces and explicitly switch the host binding and stored contexts after testing; no automatic legacy data migration or deletion is performed.

For the complete integration sequence, see the [integration guide](https://github.com/corca-ai/eye/blob/main/docs/INTEGRATION.md). Generated [SDK reference](https://github.com/corca-ai/eye/blob/main/docs/api/client.md) and [parameter reference](https://github.com/corca-ai/eye/blob/main/docs/api/types.md) describe the installed API.

For request-scoped identity, safe fallback, concrete session storage and cookie preparation examples, see [application integration](https://github.com/corca-ai/eye/blob/main/docs/APPLICATION-INTEGRATION.md). `createEyeRequest` wraps page/event use; keep `createEye` for administration, analytics and explicit preparation.

Automatic invocation logs are disabled to avoid one stored log per RPC/Queue/alarm invocation. Explicit diagnostic logs remain enabled with head sampling 1; Eye does not sample raw analytics events. For temporary request-level diagnosis, enable `observability.logs.invocation_logs` and redeploy. Existing sink settings are not changed by a code deployment or by editing `resources.json` after provisioning; do not delete/recreate a sink pointing at an existing table as an update strategy.

For upgrades from the earlier incremental v2 engine, retain the EXPERIMENTS binding, ExperimentObject export and existing migration history. The first access seals each old experiment and imports its configuration and moments in restartable pages; old policy outboxes still drain from their original objects. Do not roll back to a pre-atomic binary after cutover: it cannot read new SiteControl statistics. Read the [atomic learning upgrade guide](https://github.com/corca-ai/eye/blob/main/docs/ATOMIC-LEARNING.md) before deployment. Compatibility removal is tracked in [issue #13](https://github.com/corca-ai/eye/issues/13), checked each release. This upgrade does not automatically delete old state.
