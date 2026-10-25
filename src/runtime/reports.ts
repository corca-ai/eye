import type { RuntimeEnv as Env } from './environment.generated.js';
import { StoredObject, storedJson } from './base.js';
import { BasinAnalytics, type AnalyticsEnv } from '../analytics/query.js';
import { canonicalJSON, runJobQuery, validateJobRequest } from '../analytics/job-query.js';
import type { AnalyticsJob, AnalyticsJobInput, AnalyticsJobPage, AnalyticsJobRef, AnalyticsRequest, AnalyticsResult, BasicReport, ReportSchedule, ReportScheduleInput, ReportScheduleRef } from '../analytics/jobs.js';
import { invariant } from '../core/errors.js';
import { id, record } from '../core/validation.js';
import { SUMMARY_HOUR_MS, validateSummaryTarget } from '../analytics/summary-query.js';

const RETAIN_MS = 3_600_000, FRESH_MS = 900_000, LEASE_MS = 120_000;
interface JobRow extends Record<string, SqlStorageValue> {
  job_id: string; cache_key: string; scope: string; request: string; status: AnalyticsJob['status'];
  created_at: number; completed_at: number | null; expires_at: number; next_at: number; attempts: number; error: string | null;
}
interface ScheduleRow extends Record<string, SqlStorageValue> {
  schedule_id: string; scope: string; report: string; window_ms: number; interval_ms: number;
  next_at: number; current_job: string | null; latest_job: string | null; version: string; error: string | null;
}
function publicJob(row: JobRow): AnalyticsJob {
  return { jobId: row.job_id, kind: storedJson<AnalyticsRequest>(row.request).kind, status: row.status,
    createdAt: row.created_at, completedAt: row.completed_at, expiresAt: row.expires_at, attempts: row.attempts,
    freshUntil: row.completed_at === null ? null : Math.min(row.expires_at, row.completed_at + FRESH_MS), error: row.error };
}
/** One coordinator per site; no user-request selection path calls this object. */
export class ReportObject extends StoredObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS report_jobs (
      job_id TEXT PRIMARY KEY, cache_key TEXT NOT NULL, scope TEXT NOT NULL, request TEXT NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER, expires_at INTEGER NOT NULL,
      next_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE INDEX IF NOT EXISTS report_jobs_cache ON report_jobs(cache_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS report_jobs_schedule ON report_jobs(status, next_at);
      CREATE TABLE IF NOT EXISTS report_schedules (
        schedule_id TEXT NOT NULL, scope TEXT NOT NULL, report TEXT NOT NULL, window_ms INTEGER NOT NULL,
        interval_ms INTEGER NOT NULL, next_at INTEGER NOT NULL, current_job TEXT, latest_job TEXT,
        version TEXT NOT NULL, error TEXT, PRIMARY KEY(scope, schedule_id));`);
  }
  private key(jobId: string): string { return `eye/reports/${this.ctx.id.toString()}/${jobId}.json`; }
  private row(input: AnalyticsJobRef): JobRow {
    record(input, 'job reference'); id(input.scope, 'scope'); id(input.jobId, 'jobId');
    const row = this.sql.exec<JobRow>('SELECT * FROM report_jobs WHERE job_id = ? AND scope = ? AND expires_at > ?', input.jobId, input.scope, Date.now()).toArray()[0];
    invariant(row, 'not_found', 'Analytics job not found or expired'); return row;
  }
  async create(siteId: string, input: AnalyticsJobInput): Promise<AnalyticsJob> {
    return this.enqueue(siteId, input, RETAIN_MS);
  }
  private async enqueue(siteId: string, input: AnalyticsJobInput, retainMs: number): Promise<AnalyticsJob> {
    id(siteId, 'siteId'); record(input, 'job input'); id(input.scope, 'scope');
    const request = validateJobRequest(siteId, input.request, Date.now());
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([1, siteId, input.scope, request])));
    const cacheKey = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
    const now = Date.now();
    const existing = this.sql.exec<JobRow>(`SELECT * FROM report_jobs WHERE cache_key = ? AND expires_at > ?
AND (status IN ('queued','running') OR (status = 'complete' AND completed_at > ?)) ORDER BY created_at DESC LIMIT 1`, cacheKey, now, now - FRESH_MS).toArray()[0];
    if (existing) {
      if (existing.expires_at < existing.created_at + retainMs) { existing.expires_at = existing.created_at + retainMs; this.sql.exec('UPDATE report_jobs SET expires_at=? WHERE job_id=?', existing.expires_at, existing.job_id); }
      if (existing.status !== 'complete') await this.wakeAt(Math.max(now + 1000, existing.next_at));
      return publicJob(existing);
    }
    const counts = this.sql.exec<{ total: number; pending: number }>(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END),0) AS pending FROM report_jobs`).one();
    invariant(counts.total < 256 && counts.pending < 8, 'unavailable', 'Analytics job capacity reached; wait for existing jobs or expiry');
    invariant(this.kv.get('siteId') === undefined || this.kv.get('siteId') === siteId, 'conflict', 'Report object belongs to another site');
    this.kv.put('siteId', siteId);
    const jobId = crypto.randomUUID();
    this.sql.exec(`INSERT INTO report_jobs(job_id,cache_key,scope,request,status,created_at,expires_at,next_at) VALUES (?,?,?,?,'queued',?,?,?)`, jobId, cacheKey, input.scope, request, now, now + retainMs, now);
    await this.wakeAt(now + 1000);
    return this.status({ scope: input.scope, jobId });
  }
  private scheduleRow(input: ReportScheduleRef): ScheduleRow {
    record(input, 'schedule reference'); id(input.scope, 'scope'); id(input.scheduleId, 'scheduleId');
    const row = this.sql.exec<ScheduleRow>('SELECT * FROM report_schedules WHERE scope=? AND schedule_id=?', input.scope, input.scheduleId).toArray()[0];
    invariant(row, 'not_found', 'Report schedule not found'); return row;
  }
  async schedule(siteId: string, input: ReportScheduleInput): Promise<ReportSchedule> {
    id(siteId, 'siteId'); record(input, 'schedule'); id(input.scope, 'scope'); id(input.scheduleId, 'scheduleId');
    const report = record(input.report, 'basic report');
    invariant(report.kind === 'learning' || report.kind === 'goals' || report.kind === 'summary', 'invalid_input', 'Unsupported report kind');
    invariant(Object.keys(report).every(key => key === 'kind' || (report.kind === 'learning' && key === 'experimentId') || (report.kind === 'summary' && key === 'target')), 'invalid_input', 'Unsupported basic report option');
    if (report.experimentId !== undefined) id(report.experimentId, 'experimentId');
    if (report.kind === 'summary') {
      validateSummaryTarget(report.target);
      invariant(input.windowMs % SUMMARY_HOUR_MS === 0, 'invalid_input', 'Summary windowMs must be whole hours');
    }
    const interval = input.intervalMs ?? RETAIN_MS;
    invariant(Number.isSafeInteger(interval) && interval >= RETAIN_MS && interval <= 24 * RETAIN_MS, 'invalid_input', 'intervalMs must be 1–24 hours');
    invariant(Number.isSafeInteger(input.windowMs) && input.windowMs >= RETAIN_MS && input.windowMs <= 59 * 24 * RETAIN_MS, 'invalid_input', 'windowMs must be 1 hour–59 days');
    invariant(this.kv.get('siteId') === undefined || this.kv.get('siteId') === siteId, 'conflict', 'Report object belongs to another site');
    const json = canonicalJSON(report), now = Date.now();
    const existing = this.sql.exec<ScheduleRow>('SELECT * FROM report_schedules WHERE scope=? AND schedule_id=?', input.scope, input.scheduleId).toArray()[0];
    if (!existing) invariant(this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM report_schedules').one().n < 32, 'unavailable', 'Report schedule capacity reached');
    if (!existing || existing.report !== json || existing.window_ms !== input.windowMs || existing.interval_ms !== interval) {
      this.kv.put('siteId', siteId);
      this.sql.exec(`INSERT INTO report_schedules(schedule_id,scope,report,window_ms,interval_ms,next_at,version) VALUES (?,?,?,?,?,?,?)
ON CONFLICT(scope,schedule_id) DO UPDATE SET report=excluded.report,window_ms=excluded.window_ms,interval_ms=excluded.interval_ms,
next_at=excluded.next_at,current_job=NULL,latest_job=NULL,version=excluded.version,error=NULL`, input.scheduleId, input.scope, json, input.windowMs, interval, now, crypto.randomUUID());
    }
    await this.wakeAt(Math.max(now + 1000, this.scheduleRow(input).next_at));
    return this.getSchedule(input);
  }
  async getSchedule(input: ReportScheduleRef): Promise<ReportSchedule> {
    const row = this.scheduleRow(input);
    const lookup = (jobId: string | null): AnalyticsJob | null => {
      if (jobId === null) return null;
      const job = this.sql.exec<JobRow>('SELECT * FROM report_jobs WHERE job_id=? AND scope=? AND expires_at>?', jobId, row.scope, Date.now()).toArray()[0];
      return job ? publicJob(job) : null;
    };
    const currentJob = lookup(row.current_job), latestJob = currentJob?.status === 'complete' ? currentJob : lookup(row.latest_job);
    return { scope: row.scope, scheduleId: row.schedule_id, report: storedJson<BasicReport>(row.report), windowMs: row.window_ms,
      intervalMs: row.interval_ms, nextAt: row.next_at, currentJob, latestJob, error: row.error };
  }
  async unschedule(input: ReportScheduleRef): Promise<void> {
    this.scheduleRow(input);
    this.sql.exec('DELETE FROM report_schedules WHERE scope=? AND schedule_id=?', input.scope, input.scheduleId);
  }
  private async scheduleDue(now: number): Promise<void> {
    const row = this.sql.exec<ScheduleRow>('SELECT * FROM report_schedules WHERE next_at<=? ORDER BY next_at,scope,schedule_id LIMIT 1', now).toArray()[0];
    if (!row) return;
    const report = storedJson<BasicReport>(row.report);
    const range = { from: now - row.window_ms, to: now, limit: 1000 };
    const endHour = Math.floor(now / SUMMARY_HOUR_MS) * SUMMARY_HOUR_MS;
    const request: AnalyticsRequest = report.kind === 'summary'
      ? { kind: 'summary', query: { ...report.target, from: endHour - row.window_ms, to: endHour } }
      : report.kind === 'goals' ? { kind: 'goals', query: range }
      : { kind: 'learning', query: { ...range, ...(report.experimentId === undefined ? {} : { experimentId: report.experimentId }) } };
    try {
      const job = await this.enqueue(this.kv.get<string>('siteId')!, { scope: row.scope, request }, 2 * row.interval_ms + RETAIN_MS);
      this.sql.exec('UPDATE report_schedules SET current_job=?,next_at=?,error=NULL WHERE scope=? AND schedule_id=? AND version=?',
        job.jobId, now + row.interval_ms, row.scope, row.schedule_id, row.version);
    } catch {
      // Ordinary queued jobs retain their place. Retry registration without
      // catching up missed intervals or exposing upstream diagnostics.
      this.sql.exec("UPDATE report_schedules SET next_at=?,error='registration_unavailable' WHERE scope=? AND schedule_id=? AND version=?",
        now + 60_000, row.scope, row.schedule_id, row.version);
    }
  }
  async status(input: AnalyticsJobRef): Promise<AnalyticsJob> { return publicJob(this.row(input)); }
  async cancel(input: AnalyticsJobRef): Promise<AnalyticsJob> {
    const row = this.row(input);
    if (row.status === 'queued' || row.status === 'running') this.sql.exec("UPDATE report_jobs SET status='cancelled', error=NULL WHERE job_id=?", row.job_id);
    return this.status(input);
  }
  async page(input: AnalyticsJobRef & { offset?: number; limit?: number }): Promise<string> {
    const row = this.row(input), offset = input.offset ?? 0, limit = input.limit ?? 100;
    invariant(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000, 'invalid_input', 'Invalid result page');
    invariant(row.status === 'complete', 'conflict', 'Analytics job is not complete');
    const object = await this.env.REPORT_RESULTS.get(this.key(row.job_id));
    invariant(object && object.size <= 16 * 1024 * 1024, 'unavailable', 'Analytics result missing or oversized');
    const result = await object.json<AnalyticsResult>();
    // Recheck expiry/authorization after I/O. Pagination keeps the same result kind
    // and metadata; only the matching row array is sliced.
    const job = await this.status(input);
    const sliced = { ...result, data: { ...result.data, rows: result.data.rows.slice(offset, offset + limit) } } as AnalyticsResult;
    const page: AnalyticsJobPage = { job, request: storedJson<AnalyticsRequest>(row.request), result: sliced, offset, nextOffset: offset + limit < result.data.rows.length ? offset + limit : null };
    // JSON carries arbitrary timeline payloads over RPC without turning unknown
    // nested objects into RPC stubs. The SDK restores the public result shape.
    return JSON.stringify(page);
  }
  override async alarm(): Promise<void> { await this.retryAlarm(() => this.work()); }
  private async work(): Promise<void> {
    const now = Date.now();
    // Delete objects before their index rows, so an interrupted cleanup is retried.
    for (const row of this.sql.exec<JobRow>('SELECT * FROM report_jobs WHERE expires_at <= ? LIMIT 32', now).toArray()) {
      await this.env.REPORT_RESULTS.delete(this.key(row.job_id));
      this.sql.exec('DELETE FROM report_jobs WHERE job_id = ?', row.job_id);
    }
    await this.scheduleDue(now);
    const readyAt = Date.now();
    const job = this.sql.exec<JobRow>("SELECT * FROM report_jobs WHERE status IN ('queued','running') AND next_at <= ? AND expires_at > ? ORDER BY next_at, created_at LIMIT 1", readyAt, readyAt).toArray()[0];
    if (job) {
      this.sql.exec("UPDATE report_jobs SET status='running', attempts=MIN(attempts+1,3), next_at=? WHERE job_id=?", now + LEASE_MS, job.job_id);
      await this.wakeAt(now + LEASE_MS);
      try {
        // A crash after R2 put but before SQL publication reuses the frozen result.
        const frozen = await this.env.REPORT_RESULTS.head(this.key(job.job_id));
        const current = this.sql.exec<{ status: string }>('SELECT status FROM report_jobs WHERE job_id=?', job.job_id).toArray()[0];
        if (!frozen && current?.status === 'running') {
          invariant(job.attempts < 3, 'unavailable', 'Report retry limit reached');
          const siteId = this.kv.get<string>('siteId');
          invariant(siteId, 'unavailable', 'Missing report site');
          const request = storedJson<AnalyticsRequest>(job.request);
          const result: AnalyticsResult = request.kind === 'summary'
            ? { kind: 'summary', data: await this.env.SITES.getByName(siteId).querySummary(request.query) }
            : await runJobQuery(new BasinAnalytics(this.env as Env & AnalyticsEnv, siteId), request);
          const json = JSON.stringify(result);
          invariant(new TextEncoder().encode(json).length <= 16 * 1024 * 1024, 'invalid_input', 'Report result exceeds 16 MiB; narrow the query');
          await this.env.REPORT_RESULTS.put(this.key(job.job_id), json, { onlyIf: { etagDoesNotMatch: '*' } });
        }
        this.sql.exec("UPDATE report_jobs SET status='complete', completed_at=?, error=NULL WHERE job_id=? AND status='running'", Date.now(), job.job_id);
      } catch (error) {
        const permanent = typeof error === 'object' && error !== null && 'code' in error && (error.code === 'invalid_input' || error.code === 'outside_retention');
        const exhausted = job.attempts + 1 >= 3;
        // Do not expose SQL, credentials, or upstream response bodies in job errors.
        this.sql.exec("UPDATE report_jobs SET status=?, next_at=?, error=? WHERE job_id=? AND status='running'",
          permanent || exhausted ? 'failed' : 'queued', Date.now() + (job.attempts === 0 ? 60_000 : 300_000),
          permanent ? 'invalid_query' : 'query_unavailable', job.job_id);
      }
    }
    this.sql.exec(`UPDATE report_schedules SET latest_job=current_job WHERE current_job IS NOT NULL AND current_job IN
(SELECT job_id FROM report_jobs WHERE status='complete') AND (latest_job IS NULL OR latest_job!=current_job)`);
    const next = this.sql.exec<{ at: number | null }>(`SELECT MIN(at) AS at FROM (
SELECT expires_at AS at FROM report_jobs UNION ALL SELECT next_at AS at FROM report_jobs WHERE status IN ('queued','running') UNION ALL SELECT next_at AS at FROM report_schedules)`).one().at;
    // Replace retryAlarm's safety alarm after a successful work step. Calls to
    // create interleaving after this synchronous selection can schedule earlier.
    const pending = next === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
    if (next === null) this.kv.delete('alarmAt'); else this.kv.put('alarmAt', Math.max(Date.now() + 1000, next));
    await pending;
  }
}
