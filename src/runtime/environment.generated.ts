// Generated from Wrangler types by scripts/generate-public-env.mjs. Do not edit.
export interface RuntimeEnv {
	REPORT_RESULTS: R2Bucket;
	EVENTS: Queue;
	ANALYTICS: import("cloudflare:pipelines").Pipeline<import("cloudflare:pipelines").PipelineRecord>;
	EYE_INSTALLATION_ID: string;
	SITES: DurableObjectNamespace<import("../worker.js").SiteControl>;
	REPORTS: DurableObjectNamespace<import("../worker.js").ReportObject>;
}
