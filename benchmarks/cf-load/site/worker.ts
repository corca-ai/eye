import { DurableObject } from 'cloudflare:workers';
import { createEye, DecisionCache } from '../../../src/index';
import type { EyeService, DecisionMetric, Submission } from '../../../src/index';

// String references in cf config cannot infer RPC classes; refine only those two bindings.
type Env = Omit<Cloudflare.Env, 'EYE' | 'SESSIONS'> & {
  EYE: EyeService; SESSIONS: DurableObjectNamespace<Session>;
};
export class Session extends DurableObject<Env> {
  clear(): void { this.ctx.storage.kv.delete('tokens'); }
  read(): Record<string, string> { return this.ctx.storage.kv.get<Record<string, string>>('tokens') ?? {}; }
  put(id: string, token: string): void {
    this.ctx.storage.kv.put('tokens', { ...this.read(), [id]: token });
  }
}
const cache = new DecisionCache();
const experiments = ['checkout', 'hero', 'pricing'];
async function authorized(request: Request, token: string): Promise<boolean> {
  if (typeof token !== 'string' || token.length < 32) return false;
  const supplied = request.headers.get('Authorization') ?? '';
  const digest = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return crypto.subtle.timingSafeEqual(await digest(supplied), await digest(`Bearer ${token}`));
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!await authorized(request, env.TEST_TOKEN)) return new Response('Unauthorized', { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === '/ping') return new Response(JSON.stringify({ mode: 'baseline', sessionMs: 0, eyeMs: 0, metrics: [], submitted: 0, rejected: 0, fill: 'x'.repeat(3984) }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    const siteId = url.searchParams.get('site') ?? 'load';
    const admin = createEye({ service: env.EYE, ctx, siteId, onError: e => console.error('delivery', String(e)) });
    if (url.pathname === '/fetch-probe') {
      const carrier = { request: fetch };
      const results: Record<string, unknown> = {};
      for (const [name, call] of Object.entries({ direct: () => fetch('https://api.sql.cloudflarestorage.com/'), member: () => carrier.request('https://api.sql.cloudflarestorage.com/'), bound: () => fetch.bind(globalThis)('https://api.sql.cloudflarestorage.com/'), redirect: () => fetch('https://api.sql.cloudflarestorage.com/', { redirect: 'error' }), signal: () => fetch('https://api.sql.cloudflarestorage.com/', { signal: AbortSignal.timeout(30000) }) })) {
        try { const r = await call(); results[name] = r.status; await r.body?.cancel(); } catch (e) { results[name] = String(e); }
      }
      return Response.json(results);
    }
    if (url.pathname === '/benchmark/schedules') {
      if (request.method === 'POST') {
        const input = await request.json() as Omit<import('../../../src/analytics/jobs').ReportScheduleInput, 'scope'>;
        return Response.json(await admin.analytics.jobs.schedule({ ...input, scope: 'benchmark' }));
      }
      const ref = { scope: 'benchmark', scheduleId: url.searchParams.get('scheduleId') ?? '' };
      if (request.method === 'DELETE') { await admin.analytics.jobs.unschedule(ref); return new Response(null, { status: 204 }); }
      return Response.json(await admin.analytics.jobs.scheduled(ref));
    }
    if (url.pathname === '/benchmark/jobs') {
      if (request.method === 'POST') return Response.json(await admin.analytics.jobs.create({ scope: 'benchmark',
        request: await request.json() as import('../../../src/analytics/jobs').AnalyticsRequest }));
      const ref = { scope: 'benchmark', jobId: url.searchParams.get('jobId') ?? '' };
      return Response.json(url.searchParams.has('page') ? await admin.analytics.jobs.page({ ...ref, limit: 1, offset: Number(url.searchParams.get('offset') ?? 0) }) : await admin.analytics.jobs.status(ref));
    }
    if (url.pathname === '/benchmark/seed' && request.method === 'POST') {
      const input = await request.json() as unknown[];
      return Response.json(await (env.EYE as unknown as { benchmarkSeed(input: unknown[]): Promise<unknown> }).benchmarkSeed(input));
    }
    if (url.pathname === '/benchmark/learn' && request.method === 'POST') {
      return Response.json(await (env.EYE as unknown as { benchmarkLearn(site: string, from: number, until: number, publish: boolean): Promise<unknown> })
        .benchmarkLearn(siteId, Number(url.searchParams.get('from')), Number(url.searchParams.get('until')), url.searchParams.get('publish') === '1'));
    }
    if (url.pathname === '/setup' && request.method === 'POST') {
      for (const goal of ['purchase', 'signup', 'refund']) await admin.goals.create(goal);
      for (const experimentId of experiments) await admin.experiments.create({ experimentId,
        arms: ['a', 'b', 'c'], settings: url.searchParams.get('profile') === 'long' || experimentId === 'checkout' ? { minHoldMs: 86_400_000 }
          : { minHoldMs: 30_000, observationWindowMs: 120_000, allowedLatenessMs: 10_000,
              attributionHalfLifeMs: 120_000, learningHalfLifeMs: 600_000 } });
      return Response.json({ siteId, experiments });
    }
    if (url.pathname === '/identity' && request.method === 'POST') {
      const cid = request.headers.get('X-Cid'), uid = request.headers.get('X-Uid');
      if (!cid || !uid) return new Response('Missing identity', { status: 400 });
      admin.identify({ subject: { cid: `cid-${cid}`, uid: `uid-${uid}` } });
      await admin.flush();
      await env.SESSIONS.getByName(`${siteId}:${cid}`).clear();
      return Response.json({ accepted: true });
    }
    if (url.pathname === '/report') {
      try {
      const to = Date.now(), from = Number(url.searchParams.get('from') ?? to - 3_600_000);
      const policy = await Promise.all(experiments.map(id => admin.experiments.policy(id)));
      const goals = await admin.analytics.goals({ from, to });
      const arms = await Promise.all(experiments.map(experimentId => admin.analytics.arms({ experimentId, from, to })));
      const traffic = await Promise.all(experiments.map(experimentId => admin.analytics.traffic({ experimentId, from, to, bucketMs: 60_000, limit: 1000 })));
      const events = await admin.analytics.attributeValues({ from, to, field: { key: 'run', type: 'string' }, limit: 1000 });
      return Response.json({ policy, goals, arms, traffic, events });
      } catch (error) {
        return Response.json({ error: String(error), code: error && typeof error === 'object' && 'code' in error ? error.code : null }, { status: 502 });
      }
    }
    if (url.pathname === '/prepare' && request.method === 'POST') {
      const sid=request.headers.get('X-Session-ID');
      if (!sid || !/^[a-zA-Z0-9_-]{1,160}$/.test(sid)) return new Response('Invalid session',{status:400});
      const subject={cid:`cid-${sid}`,...(request.headers.get('X-Authenticated')==='1'?{uid:`uid-${sid}`}:{})};
      const client=createEye({service:env.EYE,ctx,siteId,decisions:{secret:env.EYE_DECISION_SECRET,cache}});
      const prepared=await Promise.all(experiments.map(async id=>[id,(await client.prepare({subject,experimentId:id})).token]));
      return Response.json({tokens:Object.fromEntries(prepared)});
    }
    if (url.pathname !== '/page' && url.pathname !== '/fast-page') return new Response('Not found', { status: 404 });
    const run = url.searchParams.get('run') ?? 'smoke';
    const requestId = request.headers.get('X-Request-ID') ?? crypto.randomUUID();
    const sessionId = request.headers.get('X-Session-ID') ?? requestId;
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(sessionId)) return new Response('Invalid session', { status: 400 });
    const uid = request.headers.get('X-Authenticated') === '1' ? `uid-${sessionId}` : undefined;
    const subject = { cid: `cid-${sessionId}`, ...(uid === undefined ? {} : { uid }) };
    const session = env.SESSIONS.getByName(`${siteId}:${sessionId}`);
    const start = performance.now();
    const inline = url.pathname === '/fast-page';
    const supplied: unknown = inline ? JSON.parse(request.headers.get('X-Eye-Tokens') ?? '{}') : await session.read();
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.values(supplied).some(value => typeof value !== 'string')) return new Response('Invalid tokens',{status:400});
    const tokens = supplied as Record<string,string>;
    const sessionMs = performance.now() - start;
    const metrics: DecisionMetric[] = [];
    const submissions: Submission[] = [];
    const eyeStart = performance.now();
    const mode = url.searchParams.get('mode') === 'baseline' ? 'baseline' : 'eye';
    let responseTokens = tokens;
    if (mode === 'eye') {
      const eye = createEye({ service: env.EYE, ctx, siteId,
        decisions: { secret: env.EYE_DECISION_SECRET, cache, tokens,
          ...(!inline ? { onPrepared: (id: string, token: string) => session.put(id, token) } : {}), onDecision: m => metrics.push(m) },
        onError: e => console.error('delivery', String(e)) });
      for (const experimentId of experiments) {
        const decision = await eye.decide({ subject, experimentId });
        if (decision.status === 'assigned') submissions.push(eye.expose({ subject, decision,
          eventId: `${run}:${requestId}:exposure:${experimentId}`,
          userAttributes: { cohort: uid ? 'authenticated' : 'anonymous', device: 'synthetic' }, attributes: { run } }));
      }
      submissions.push(eye.track({ subject, eventId: `${run}:${requestId}:track`, name: 'page_view', attributes: { run, path: '/page' } }));
      const goal = request.headers.get('X-Goal');
      if (goal === 'purchase' || goal === 'signup' || goal === 'refund') {
        submissions.push(eye.goal({ subject, eventId: `${run}:${requestId}:goal`, goalId: goal,
          value: goal === 'refund' ? -100 : goal === 'signup' ? 1000 : 100,
          attributes: { run } }));
      }
      if (inline) responseTokens = await eye.state();
    }
    const eyeMs = performance.now() - eyeStart;
    const data = { mode, sessionMs, eyeMs, metrics, ...(inline ? { tokens: responseTokens } : {}),
      submitted: submissions.filter(s => s.accepted).length,
      rejected: submissions.filter(s => !s.accepted).length, fill: '' };
    data.fill = 'x'.repeat(Math.max(0, (inline ? 8192 : 4096) - new TextEncoder().encode(JSON.stringify(data)).length));
    return new Response(JSON.stringify(data),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Server-Timing': `session;dur=${sessionMs},eye;dur=${eyeMs}` } });
  },
} satisfies ExportedHandler<Env>;
