import { EyeWorker } from '../../../src/runtime/service';
import { LearningSource } from '../../sdk/legacy-learning';
import { parseEnvelope } from '../../../src/core/events';
import { rawRecords } from '../../../src/analytics/raw';
import { exportBatches } from '../../../src/analytics/export';
import { SiteControl as ProductionSiteControl } from '../../../src/worker';
export { ExperimentObject, ReportObject } from '../../../src/worker';

/** The old cursor-drain hook cannot represent the incremental production path. */
export class SiteControl extends ProductionSiteControl {
  override async fetch(): Promise<Response> {
    return new Response('Historical SQL-drain hook retired; use the incremental local benchmark or live Queue traffic', { status: 410 });
  }
}

/** Benchmark-only RPC entry point. HTTP is disabled and the host authenticates all access.
 * Never use this entry point in the installation template: seed bypasses goal registration
 * deliberately, so historical deterministic fixtures can be compared between versions.
 */
export default class BenchmarkEye extends EyeWorker {
  async benchmarkDrain(siteId: string, from?: number) {
    if (!siteId.startsWith('cohort-')) throw new Error('Only dedicated cohort fixtures are allowed');
    const url = `https://benchmark/benchmark/drain${from === undefined ? '' : `?from=${from}`}`;
    const response = await this.env.SITES.getByName(siteId).fetch(new Request(url, { method: from === undefined ? 'GET' : 'POST' }));
    if (!response.ok) throw new Error(`Drain hook HTTP ${response.status}`);
    return { state: await response.json(), policies: await Promise.all([0, 1, 2].map(i => this.getPolicy(siteId, `exp-${i}`))) };
  }
  async benchmarkSeed(input: unknown[]) {
    if (!Array.isArray(input) || input.length > 100) throw new Error('Fixture batch must be <=100');
    const rows = input.flatMap(item => rawRecords(parseEnvelope(item, Date.now())));
    for (const batch of exportBatches(rows.map(record => ({ record })))) await this.env.ANALYTICS.send(batch);
    return { events: input.length, records: rows.length };
  }
  // Historical SQL comparator only; this is not the production learning path.
  async benchmarkLearn(siteId: string, from: number, until: number, publish = false) {
    const queries: unknown[] = [];
    const measured: typeof fetch = async (input, init) => {
      const started = performance.now(), response = await fetch(input, init);
      const body = await response.clone().json() as { result?: { metrics?: unknown }; errors?: unknown };
      queries.push({ query: JSON.parse(String(init?.body)).query, status: response.status,
        durationMs: performance.now() - started, metrics: body.result?.metrics, errors: body.errors });
      return response;
    };
    const source = new LearningSource(this.env, siteId, { windowMs: 7 * 86400000, graceMs: 3600000, attributionMs: 7 * 86400000 }, measured);
    const pages = []; let after = '';
    try { do {
      const page = await source.page(from, until, after);
      pages.push(page);
      if (publish) for (const batch of exportBatches(page.records.map(record => ({ record })))) await this.env.ANALYTICS.send(batch);
      if (page.next === null) break;
      after = page.next;
    } while (pages.length < 40);
    return { queries, pages };
    } catch (error) { return { queries, pages, error: String(error) }; }
  }
}
