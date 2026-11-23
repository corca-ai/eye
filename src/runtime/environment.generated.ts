// Generated from Wrangler types by scripts/generate-public-env.mjs. Do not edit.
export interface RuntimeEnv {
	EVENTS: Queue;
	EYE_INSTALLATION_ID: string;
	SITES: DurableObjectNamespace<import("../worker.js").SiteControl>;
}
