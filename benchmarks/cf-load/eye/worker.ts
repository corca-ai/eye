import { EyeWorker } from '../../../src/runtime/service';
import { LearningSource } from '../../../src/runtime/learning';
import { parseEnvelope } from '../../../src/core/events';
import { rawRecords } from '../../../src/analytics/raw';
import { exportBatches } from '../../../src/analytics/export';
export { SiteControl, ExperimentObject, ReportObject } from '../../../src/worker';

/** Benchmark-only RPC entry point. HTTP is disabled and the host authenticates all access.
 * Never use this entry point in the installation template: seed bypasses goal registration
 * deliberately, so historical deterministic fixtures can be compared between versions.
 */
export default class BenchmarkEye extends EyeWorker {
  async benchmarkSeed(input: unknown[]) {
    if (!Array.isArray(input) || input.length > 100) throw new Error('Fixture batch must be <=100');
    const rows = input.flatMap(item => rawRecords(parseEnvelope(item, Date.now())));
    for (const batch of exportBatches(rows.map(record => ({ record })))) await this.env.ANALYTICS.send(batch);
    return { events: input.length, records: rows.length };
  }
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
