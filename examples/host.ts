import { createEye, getOrCreateCid, DecisionCache } from '@eye/workers';
import type { EyeService } from '@eye/workers';

interface HostEnv { EYE: EyeService; EYE_DECISION_SECRET: string }
// Reuse only policy data across requests. Each session owns its signed assignment tokens.
const policies = new DecisionCache();
interface HostSession {
  decisionTokens: Record<string, string>;
  setDecisionToken(experimentId: string, token: string): Promise<void>;
}

/** The host supplies its own authenticated uid, when available. */
export async function handlePage(request: Request, env: HostEnv, ctx: ExecutionContext, session: HostSession, uid?: string): Promise<Response> {
  const eye = createEye({ service: env.EYE, ctx, siteId: 'shop',
    decisions: { secret: env.EYE_DECISION_SECRET, cache: policies, tokens: session.decisionTokens,
      onPrepared: (experimentId, token) => session.setDecisionToken(experimentId, token) },
    onError: error => console.error('Eye delivery failed', error) });
  const cookie = getOrCreateCid(request);
  const subject = { cid: cookie.cid, ...(uid === undefined ? {} : { uid }) };
  const decision = await eye.decide({ subject, experimentId: 'checkout' });
  const content = decision.status === 'assigned' && decision.assignment.armId === 'compact'
    ? '<main>Compact checkout</main>' : '<main>Standard checkout</main>';
  const response = new Response(content, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (cookie.setCookie) response.headers.append('Set-Cookie', cookie.setCookie);
  if (decision.status === 'assigned') eye.expose({ subject, decision, userAttributes: { locale: 'ko' } });
  eye.track({ subject, name: 'page_view', attributes: { path: new URL(request.url).pathname } });
  return response;
}

/** Invoke from a trusted setup job or administration route, once per definition. */
export async function configure(env: HostEnv, ctx: ExecutionContext): Promise<void> {
  const eye = createEye({ service: env.EYE, ctx, siteId: 'shop' });
  await eye.goals.create('purchase');
  await eye.goals.create('refund');
  await eye.experiments.create({ experimentId: 'checkout', arms: ['standard', 'compact'], settings: { minHoldMs: 86_400_000 } });
}

export async function compareLocale(env: HostEnv, ctx: ExecutionContext) {
  const eye = createEye({ service: env.EYE, ctx, siteId: 'shop' }), to = Date.now();
  return eye.analytics.arms({ experimentId: 'checkout', from: to - 7 * 86_400_000, to, groupBy: [{ key: 'locale', type: 'string' }] });
}
