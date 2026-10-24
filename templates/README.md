# Eye installation

This directory runs inside your existing Workers project, which must have `@eye/workers` and Wrangler 4.151.3 or later installed. All resources belong to the account in `wrangler.jsonc`.

Review `resources.json`, `wrangler.jsonc`, `schema.json`, and `fanout.sql`. Authenticate Wrangler with your account and set `EYE_CATALOG_TOKEN` and `EYE_ANALYTICS_TOKEN` in your shell or secret manager. The catalog token needs permission to create/write catalog tables; the query token needs the [Basin SQL permissions](https://developers.cloudflare.com/basin-sql/query-data/#authentication). Tokens are never stored in these project files. The catalog token is passed as an argument to Wrangler's sink command; use a trusted provisioning machine.

Run `node provision.mjs` from this directory. This explicitly creates one R2 bucket, enables Catalog, creates two Queues, one Stream, seven sinks, one fan-out pipeline, and deploys the private Eye Worker. It then uploads the query token as a Worker secret. It does not deploy or modify your application. Successful creation steps are recorded locally so a retry can continue. If Cloudflare created a resource but the command failed before acknowledgement, inspect that resource before retrying; the script does not adopt or delete arbitrary existing resources.

The initial Stream ID is a placeholder. Do not deploy this config before provisioning has replaced it. The pipeline rolls files at 60 seconds; query visibility is eventual. No old-data deletion or archival rule is installed. Keep `.provision-state.json` to resume setup; back up resource configuration through your usual infrastructure process.

Add this binding to your application's Wrangler config (replace `eye` with the Worker name):

```json
{ "services": [{ "binding": "EYE", "service": "eye" }] }
```

Use `createEye({ service: env.EYE, ctx, siteId: "your-site" })` for each request. `EyeService` is the structural TypeScript type for `env.EYE`; regenerate application binding types with Wrangler. See the package README for tracking, actual exposure, goal and analysis examples. Register goals and experiments once through a trusted administrative path, rather than on each request. The Worker exposes RPC only; HTTP returns 404. Your service must authenticate and authorize any public administrative or analysis endpoints it chooses to build.

For later code-only updates, run `wrangler deploy --config wrangler.jsonc`. Changes to a Stream/table schema or pipeline need a reviewed migration; re-running the provision script is not a schema migration mechanism.

Fast `decide()` uses a local policy cache and signed per-device context; it requires a host `decisions.secret` (at least 32 UTF-8 bytes). Save updates from `onPrepared` in the host session, or await `state()` after exposure and save the result in response cookies. Cold/expired policy requests skip participation. `prepare()` explicitly waits for a policy RPC. There is no central assignment or `decideConsistent()` API.

The COHORTS R2 binding uses the analytics bucket for temporary frozen learning results under `eye/cohorts/`. This config's `v2-fresh` migration is for a new installation only. Do not replace an existing v1 migration history with it. Install a new Worker/namespaces and explicitly switch the host binding and stored contexts after testing; no automatic legacy data migration or deletion is performed.

For the complete integration sequence, see the [integration guide](https://github.com/corca-ai/eye/blob/main/docs/INTEGRATION.md). Generated [SDK reference](https://github.com/corca-ai/eye/blob/main/docs/api/client.md) and [parameter reference](https://github.com/corca-ai/eye/blob/main/docs/api/types.md) describe the installed API.

For request-scoped identity, safe fallback, concrete session storage and cookie preparation examples, see [application integration](https://github.com/corca-ai/eye/blob/main/docs/APPLICATION-INTEGRATION.md). `createEyeRequest` wraps page/event use; keep `createEye` for administration, analytics and explicit preparation.
