// Generated from Wrangler types by scripts/generate-public-env.mjs. Do not edit.
export interface RuntimeEnv {
	EVENTS: Queue;
	ANALYTICS: import("cloudflare:pipelines").Pipeline<import("cloudflare:pipelines").PipelineRecord>;
	SITES: DurableObjectNamespace<import("../worker.js").SiteControl>;
	EXPERIMENTS: DurableObjectNamespace<import("../worker.js").ExperimentObject>;
	OBSERVATIONS: DurableObjectNamespace<import("../worker.js").ObservationShard>;
	SUBJECTS: DurableObjectNamespace<import("../worker.js").SubjectObject>;
	IDENTITIES: DurableObjectNamespace<import("../worker.js").IdentityRegistry>;
}
