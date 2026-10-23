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

Fast `decide()` requires a host `decisions.secret` (at least 32 UTF-8 bytes) and signed tokens retained in the host session. Supply `onPrepared` to persist background preparations; clear tokens on authentication/session transitions. It skips cold/unprepared requests. `prepare()` is an explicit waiting preparation API; `decideConsistent()` retains the prior waiting central path. See the host example and `docs/FAST-DECISIONS.md` in the source repository.

For the complete integration sequence, see the [integration guide](https://github.com/corca-ai/eye/blob/main/docs/INTEGRATION.md). Generated [SDK reference](https://github.com/corca-ai/eye/blob/main/docs/api/client.md) and [parameter reference](https://github.com/corca-ai/eye/blob/main/docs/api/types.md) describe the installed API.
