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
