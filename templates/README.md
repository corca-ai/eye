# Eye installation

This directory runs inside your existing Workers project, which must have `@eye/workers` and Wrangler 4.151.3 or later installed. All resources belong to the account in `wrangler.jsonc`.

Review `resources.json`, `wrangler.jsonc`, `schema.json`, and `fanout.sql`. Authenticate Wrangler with your account and set `EYE_CATALOG_TOKEN` and `EYE_ANALYTICS_TOKEN` in your shell or secret manager. The catalog token needs permission to create/write catalog tables; the query token needs the [Basin SQL permissions](https://developers.cloudflare.com/basin-sql/query-data/#authentication). Tokens are never stored in these project files. The catalog token is passed as an argument to Wrangler's sink command; use a trusted provisioning machine.

Run `node provision.mjs` from this directory. This explicitly creates one R2 bucket, enables Catalog, creates two Queues, one Stream, two sinks, one pipeline, and deploys the private Eye Worker. It then uploads the query token as a Worker secret. It does not deploy or modify your application. Successful creation steps are recorded locally so a retry can continue. If Cloudflare created a resource but the command failed before acknowledgement, inspect that resource before retrying; the script does not adopt or delete arbitrary existing resources.

The initial Stream ID is a placeholder. Do not deploy this config before provisioning has replaced it. New installations roll files at 300 seconds. Before provisioning, set `sinkRollIntervalSeconds` in `resources.json` to an integer from 60 to 300 if a shorter delay is needed. Query visibility is eventual: the roll interval is not an end-to-end delivery bound. The default one-hour learning grace leaves room for this batching. If you choose a short `allowedLatenessMs`, measure Queue/Stream/Catalog visibility and select an appropriate roll interval before relying on learning results; data arriving after closure is not used to correct learning. Provisioning enables Catalog snapshot expiration (older than one day, retaining at least the current snapshot). This reclaims unreferenced files after maintenance; it does not expire live rows. Schedule the SDK maintenance/retention.py Catalog transaction at least daily to remove rows older than 60 days. No R2 object lifecycle rule is installed. See the SDK maintenance/README.md for permissions, validation mode, and physical-cleanup verification. Keep `.provision-state.json` to resume setup; back up resource configuration through your usual infrastructure process.

Add this binding to your application's Wrangler config (replace `eye` with the Worker name):

```json
{ "services": [{ "binding": "EYE", "service": "eye" }] }
```

Use `createEye({ service: env.EYE, ctx })` for each request. `EyeService` is the structural TypeScript type for `env.EYE`; regenerate application binding types with Wrangler. See the package README for tracking, actual exposure, goal and analysis examples. Register goals and experiments once through a trusted administrative path, rather than on each request. The Worker exposes RPC only; HTTP returns 404. Your service must authenticate and authorize any public administrative or analysis endpoints it chooses to build.

For later code-only updates, run `wrangler deploy --config wrangler.jsonc`. Review Stream/table schema and pipeline changes separately; provisioning creates resources and is not an update mechanism.

Fast `decide()` uses a local policy cache and signed per-device context; it requires a host `decisions.secret` (at least 32 UTF-8 bytes). Save updates from `onPrepared` in the host session, or await `state()` after exposure and save the result in response cookies. Cold/expired policy requests skip participation. `prepare()` explicitly waits for a policy RPC. There is no central assignment or `decideConsistent()` API.

Learning closes samples, updates experiment moments and creates its export outbox in one SiteControl SQLite transaction. SiteControl and ReportObject are the two SQLite classes registered by the initial configuration. The REPORT_RESULTS R2 binding stores asynchronous report results under `eye/reports/`. See [atomic learning](https://github.com/corca-ai/eye/blob/main/docs/ATOMIC-LEARNING.md) for transaction and retry behavior.

For the complete integration sequence, see the [integration guide](https://github.com/corca-ai/eye/blob/main/docs/INTEGRATION.md). Generated [SDK reference](https://github.com/corca-ai/eye/blob/main/docs/api/client.md) and [parameter reference](https://github.com/corca-ai/eye/blob/main/docs/api/types.md) describe the installed API.

For request-scoped identity, safe fallback, concrete session storage and cookie preparation examples, see [application integration](https://github.com/corca-ai/eye/blob/main/docs/APPLICATION-INTEGRATION.md). `createEyeRequest` wraps page/event use; keep `createEye` for administration, analytics and explicit preparation.

Automatic invocation logs are disabled to avoid one stored log per RPC/Queue/alarm invocation. Explicit diagnostic logs remain enabled with head sampling 1; Eye does not sample raw analytics events. For temporary request-level diagnosis, enable `observability.logs.invocation_logs` and redeploy. Existing sink settings are not changed by a code deployment or by editing `resources.json` after provisioning; do not delete/recreate a sink pointing at an existing table as an update strategy.

Each service/environment owns one installation, selected solely by its Service Binding.
The initializer generates `EYE_INSTALLATION_ID`; keep it unchanged for that installation.
It separates signed decision state and internal caches without a caller-supplied site ID.
Raw events use `events`; derived records share `projections`, distinguished by `table_name`. Logical analytics APIs are unchanged.
