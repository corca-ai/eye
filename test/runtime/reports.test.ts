import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { BasinAnalytics } from '../../src/analytics/query.js';
import type { AnalyticsJobInput, AnalyticsJobPage } from '../../src/analytics/jobs.js';
const input = (): AnalyticsJobInput => ({ scope: 'admins', request: { kind: 'goals', query: { from: Date.now() - 60000, to: Date.now() - 1 } } });
const result = () => ({ meta: { queriedAt: Date.now(), receivedBefore: Date.now(), consistency: 'eventual' as const, truncated: false, bytesScanned: 100 },
  rows: [1, 2, 3].map(i => ({ goalId: `g${i}`, events: i, totalValue: i * 10, latestReceivedAt: Date.now() })) });
it('coalesces canonical queries, isolates authorization scopes and pages frozen results after eviction', async () => {
  const site = crypto.randomUUID(), actor = env.REPORTS.getByName(site), request = input();
  const query = vi.spyOn(BasinAnalytics.prototype, 'goals').mockResolvedValue(result());
  try {
    const first = await actor.create(site, request);
    const same = await actor.create(site, { request: { kind: 'goals', query: { to: request.request.query.to, limit: 100, from: request.request.query.from } }, scope: 'admins' });
    expect(same.jobId).toBe(first.jobId); expect(query).not.toHaveBeenCalled();
    await runInDurableObject(actor, async a => { await expect(a.status({ jobId: first.jobId, scope: 'other' })).rejects.toThrow('not found'); });
    await runInDurableObject(actor, a => a.alarm());
    expect(query).toHaveBeenCalledTimes(1);
    await evictDurableObject(actor);
    const ref = { jobId: first.jobId, scope: 'admins' };
    const page = JSON.parse(await actor.page({ ...ref, limit: 2 })) as AnalyticsJobPage;
    expect(page.job.status).toBe('complete'); expect(page.nextOffset).toBe(2);
    expect(page.result.data.rows).toHaveLength(2);
    expect((JSON.parse(await actor.page({ ...ref, offset: page.nextOffset!, limit: 2 })) as AnalyticsJobPage).result.data.rows).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect((await actor.create(site, request)).jobId).toBe(first.jobId);
    const isolated = await actor.create(site, { ...request, scope: 'other' });
    expect(isolated.jobId).not.toBe(first.jobId);
    await actor.cancel({ scope: 'other', jobId: isolated.jobId });
  } finally { query.mockRestore(); }
});
it('cancellation during a query prevents publication and another registration gets a new job', async () => {
  const site = crypto.randomUUID(), actor = env.REPORTS.getByName(site), request = input();
  const job = await actor.create(site, request);
  let cancel!: () => Promise<unknown>;
  const query = vi.spyOn(BasinAnalytics.prototype, 'goals').mockImplementation(async () => { await cancel(); return result(); });
  try {
    await runInDurableObject(actor, async a => { cancel = () => a.cancel({ scope: 'admins', jobId: job.jobId }); await a.alarm(); });
    expect((await actor.status({ scope: 'admins', jobId: job.jobId })).status).toBe('cancelled');
    await runInDurableObject(actor, async a => { await expect(a.page({ scope: 'admins', jobId: job.jobId })).rejects.toThrow('not complete'); });
    const replacement = await actor.create(site, request);
    expect(replacement.jobId).not.toBe(job.jobId);
    await actor.cancel({ scope: 'admins', jobId: replacement.jobId });
  } finally { query.mockRestore(); }
});
it('reuses an R2 result after publication interruption and expires both status and stored results', async () => {
  const site = crypto.randomUUID(), actor = env.REPORTS.getByName(site), request = input();
  const job = await actor.create(site, request), ref = { scope: 'admins', jobId: job.jobId };
  const query = vi.spyOn(BasinAnalytics.prototype, 'goals').mockResolvedValue(result());
  try {
    await runInDurableObject(actor, async (a, state) => {
      const key = `eye/reports/${state.id.toString()}/${job.jobId}.json`;
      await env.COHORTS.put(key, JSON.stringify({ kind: 'goals', data: result() }));
      state.storage.sql.exec("UPDATE report_jobs SET status='running', next_at=0, attempts=1 WHERE job_id=?", job.jobId);
    });
    await evictDurableObject(actor);
    await runInDurableObject(actor, a => a.alarm());
    expect(query).not.toHaveBeenCalled();
    expect((JSON.parse(await actor.page(ref)) as AnalyticsJobPage).result.data.rows).toHaveLength(3);
    await runInDurableObject(actor, async (a, state) => {
      state.storage.sql.exec('UPDATE report_jobs SET expires_at=0 WHERE job_id=?', job.jobId);
      await expect(a.status(ref)).rejects.toThrow('not found');
      await a.alarm();
      expect(await env.COHORTS.head(`eye/reports/${state.id.toString()}/${job.jobId}.json`)).toBeNull();
    });
  } finally { query.mockRestore(); }
});
it('retries transient SQL failures with bounded attempts and does not execute cancelled queued jobs', async () => {
  const site = crypto.randomUUID(), actor = env.REPORTS.getByName(site), request = input();
  const job = await actor.create(site, request), ref = { scope: 'admins', jobId: job.jobId };
  const query = vi.spyOn(BasinAnalytics.prototype, 'goals').mockRejectedValue(new Error('secret upstream diagnostic'));
  try {
    for (let n = 0; n < 3; n++) await runInDurableObject(actor, async (a, state) => {
      state.storage.sql.exec('UPDATE report_jobs SET next_at=0 WHERE job_id=?', job.jobId); await a.alarm();
    });
    const failed = await actor.status(ref);
    expect(failed.status).toBe('failed'); expect(failed.attempts).toBe(3); expect(failed.error).toBe('query_unavailable');
    const second = await actor.create(site, request);
    await actor.cancel({ scope: 'admins', jobId: second.jobId });
    await runInDurableObject(actor, a => a.alarm()); expect(query).toHaveBeenCalledTimes(3);
  } finally { query.mockRestore(); }
});
it('expires cached freshness without invalidating retained pages, and bounds crash retries', async () => {
  const site = crypto.randomUUID(), actor = env.REPORTS.getByName(site), request = input();
  const query = vi.spyOn(BasinAnalytics.prototype, 'goals').mockResolvedValue(result());
  try {
    const first = await actor.create(site, request);
    await runInDurableObject(actor, a => a.alarm());
    await runInDurableObject(actor, (_a, state) => { state.storage.sql.exec('UPDATE report_jobs SET completed_at=? WHERE job_id=?', Date.now() - 900001, first.jobId); });
    const second = await actor.create(site, request);
    expect(second.jobId).not.toBe(first.jobId);
    expect(JSON.parse(await actor.page({ scope: 'admins', jobId: first.jobId })).job.status).toBe('complete');
    await runInDurableObject(actor, async (a, state) => {
      state.storage.sql.exec("UPDATE report_jobs SET status='running', attempts=3, next_at=0 WHERE job_id=?", second.jobId);
      await a.alarm();
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect((await actor.status({ scope: 'admins', jobId: second.jobId })).status).toBe('failed');
  } finally { query.mockRestore(); }
});
it('SDK returns typed report pages over the service binding and separates sites', async () => {
  const { createExecutionContext, waitOnExecutionContext } = await import('cloudflare:test');
  const { EyeWorker } = await import('../../src/runtime/service.js');
  const { createEye } = await import('../../src/client.js');
  const siteId = crypto.randomUUID(), ctx = createExecutionContext();
  const eye = createEye({ siteId, ctx, service: new EyeWorker(ctx, env) });
  const query = vi.spyOn(BasinAnalytics.prototype, 'goals').mockResolvedValue(result());
  try {
    const job = await eye.analytics.jobs.create(input());
    await runInDurableObject(env.REPORTS.getByName(siteId), a => a.alarm());
    const page = await eye.analytics.jobs.page({ scope: 'admins', jobId: job.jobId, limit: 1 });
    expect(page.result.kind).toBe('goals'); expect(page.result.data.rows).toHaveLength(1);
    await runInDurableObject(env.REPORTS.getByName(crypto.randomUUID()), async a => {
      await expect(a.status({ scope: 'admins', jobId: job.jobId })).rejects.toThrow('not found');
    });
  } finally { query.mockRestore(); await waitOnExecutionContext(ctx); }
});

it('schedules basic reports without reads triggering SQL, retains the previous result and survives eviction', async () => {
  const site = crypto.randomUUID(), actor = env.REPORTS.getByName(site);
  const request = { scope: 'admins', scheduleId: 'daily', report: { kind: 'goals' as const }, windowMs: 86400000 };
  const query = vi.spyOn(BasinAnalytics.prototype, 'goals').mockResolvedValue(result());
  try {
    await actor.schedule(site, request);
    expect((await actor.getSchedule(request)).currentJob).toBeNull(); expect(query).not.toHaveBeenCalled();
    await runInDurableObject(actor, a => a.alarm());
    const first = await actor.getSchedule(request);
    expect(first.latestJob?.status).toBe('complete');
    expect(first.latestJob!.expiresAt - first.latestJob!.createdAt).toBe(3 * 3600000);
    expect(query).toHaveBeenCalledTimes(1);
    await evictDurableObject(actor);
    expect((await actor.schedule(site, request)).latestJob?.jobId).toBe(first.latestJob!.jobId);
    expect((await actor.getSchedule(request)).latestJob?.jobId).toBe(first.latestJob!.jobId);
    const page = JSON.parse(await actor.page({ scope: 'admins', jobId: first.latestJob!.jobId })) as AnalyticsJobPage;
    expect(page.request.query.to - page.request.query.from).toBe(request.windowMs);
    await runInDurableObject(actor, async a => { await expect(a.getSchedule({ ...request, scope: 'other' })).rejects.toThrow('not found'); });
    query.mockRejectedValue(new Error('temporary'));
    await runInDurableObject(actor, async (a, state) => {
      // Expire the old request's cache so even a frozen test clock creates a new attempt.
      state.storage.sql.exec('UPDATE report_jobs SET completed_at=?', Date.now() - 900001);
      state.storage.sql.exec('UPDATE report_schedules SET next_at=0');
      await a.alarm();
    });
    const pending = await actor.getSchedule(request);
    expect(pending.currentJob?.status).toBe('queued');
    expect(pending.latestJob?.jobId).toBe(first.latestJob!.jobId);
    await actor.unschedule(request);
    await runInDurableObject(actor, async a => { await expect(a.getSchedule(request)).rejects.toThrow('not found'); });
    expect((await actor.status({ scope: 'admins', jobId: first.latestJob!.jobId })).status).toBe('complete');
  } finally { query.mockRestore(); }
});

it('validates schedules, isolates sites, and drops the previous result when report settings change', async () => {
  const site = crypto.randomUUID(), actor = env.REPORTS.getByName(site);
  const request = { scope: 'admins', scheduleId: 'report', report: { kind: 'goals' as const }, windowMs: 86400000 };
  await runInDurableObject(actor, async a => {
    await expect(a.schedule(site, { ...request, intervalMs: 59999 })).rejects.toThrow('intervalMs');
    await expect(a.schedule(site, { ...request, windowMs: 60 * 86400000 })).rejects.toThrow('windowMs');
  });
  const query = vi.spyOn(BasinAnalytics.prototype, 'goals').mockResolvedValue(result());
  try {
    await actor.schedule(site, request); await runInDurableObject(actor, a => a.alarm());
    await runInDurableObject(actor, async a => { await expect(a.schedule('other', request)).rejects.toThrow('another site'); });
    const changed = await actor.schedule(site, { ...request, report: { kind: 'learning' } });
    expect(changed.latestJob).toBeNull(); expect(changed.currentJob).toBeNull();
    expect(changed.nextAt).toBeLessThanOrEqual(Date.now());
  } finally { query.mockRestore(); }
});

it('does not publish an in-flight result into a changed schedule', async () => {
  const site = crypto.randomUUID(), actor = env.REPORTS.getByName(site);
  const request = { scope: 'admins', scheduleId: 'report', report: { kind: 'goals' as const }, windowMs: 86400000 };
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const query = vi.spyOn(BasinAnalytics.prototype, 'goals').mockImplementation(async () => { entered(); await held; return result(); });
  try {
    await actor.schedule(site, request);
    await runInDurableObject(actor, async a => {
      const work = a.alarm(); await started;
      await a.schedule(site, { ...request, windowMs: 2 * 86400000 });
      release(); await work;
      expect((await a.getSchedule(request)).latestJob).toBeNull();
    });
    await actor.unschedule(request);
  } finally { release(); query.mockRestore(); }
});

it('bounds scheduled admission while eight ordinary jobs are pending', async () => {
  const site = crypto.randomUUID(), actor = env.REPORTS.getByName(site);
  const request = { scope: 'admins', scheduleId: 'report', report: { kind: 'goals' as const }, windowMs: 86400000 };
  const query = vi.spyOn(BasinAnalytics.prototype, 'goals').mockResolvedValue(result());
  try {
    // Prevent real timer alarms from draining the queue between fixture RPCs.
    // Run the one alarm under test explicitly after establishing the full queue.
    await runInDurableObject(actor, async (a, state) => state.blockConcurrencyWhile(async () => {
      for (let i = 0; i < 8; i++) await a.create(site, { ...input(), scope: `scope-${i}` });
      await a.schedule(site, request);
      const pendingCount = () => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM report_jobs WHERE status IN ('queued','running')").one().n;
      expect(pendingCount()).toBe(8);
      await a.alarm();
      const scheduled = await a.getSchedule(request);
      expect(scheduled.currentJob).toBeNull(); expect(scheduled.error).toBe('registration_unavailable');
      expect(pendingCount()).toBe(7);
      expect(query).toHaveBeenCalledTimes(1);
    }));
  } finally { query.mockRestore(); }
});

it('does not attach a job to a deleted and recreated schedule during async registration', async () => {
  const site = crypto.randomUUID(), actor = env.REPORTS.getByName(site);
  const request = { scope: 'admins', scheduleId: 'replace', report: { kind: 'goals' as const }, windowMs: 86400000 };
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const paused = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => { entered(); await held; return digest(...args); });
  const query = vi.spyOn(BasinAnalytics.prototype, 'goals').mockResolvedValue(result());
  try {
    await actor.schedule(site, request);
    await runInDurableObject(actor, async a => {
      const work = a.alarm(); await started;
      await a.unschedule(request);
      await a.schedule(site, { ...request, windowMs: 2 * 86400000 });
      release(); await work;
      const current = await a.getSchedule(request);
      expect(current.currentJob).toBeNull(); expect(current.latestJob).toBeNull();
      expect(current.windowMs).toBe(2 * 86400000);
    });
  } finally { release(); paused.mockRestore(); query.mockRestore(); }
});
