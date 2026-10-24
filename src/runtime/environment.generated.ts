// Generated from Wrangler types by scripts/generate-public-env.mjs. Do not edit.
export interface RuntimeEnv {
	COHORTS: R2Bucket;
	EVENTS: Queue;
	ANALYTICS: import("cloudflare:pipelines").Pipeline<import("cloudflare:pipelines").PipelineRecord>;
	SITES: DurableObjectNamespace<import("../worker.js").SiteControl>;
	EXPERIMENTS: DurableObjectNamespace<import("../worker.js").ExperimentObject>;
	REPORTS: DurableObjectNamespace<import("../worker.js").ReportObject>;
}
