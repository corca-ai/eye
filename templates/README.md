# Eye Worker installation

This directory contains a private Eye Worker configuration. The provision script
creates the event and dead-letter queues, then deploys the Worker. Run it from
a project that has installed `@eye/workers` and Wrangler.

```sh
npx wrangler login
node provision.mjs
```

Provisioning checkpoints successful queue creation in `.provision-state.json`.
If a response is lost during creation, check the named queue in Cloudflare
before retrying. Keep the generated installation ID when redeploying.

Add a service binding from the host Worker to the generated Worker name.
SiteControl stores experiment and goal definitions, attribution state, policy
moments and aggregate reports in SQLite. See the
[Eye integration guide](https://github.com/corca-ai/eye/blob/main/docs/INTEGRATION.md).
