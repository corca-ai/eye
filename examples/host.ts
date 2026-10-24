import { createEye, createEyeRequest, getOrCreateCid, DecisionCache } from '@eye/workers';
import type { EyeService, VariantDefinition } from '@eye/workers';

interface HostEnv { EYE: EyeService; EYE_DECISION_SECRET: string }
// Reuse only policy data across requests. Each session owns its signed assignment tokens.
const policies = new DecisionCache();
interface HostSession {
  decisionTokens: Record<string, string>;
  setDecisionToken(experimentId: string, token: string): Promise<void>;
}

export const checkout = {
  experimentId: 'checkout',
  variants: { standard: 'standard', compact: 'compact' },
  fallback: 'standard',
} as const satisfies VariantDefinition<'standard' | 'compact'>;

/** Common request boundary. Reuse the session already loaded by host authentication. */
export function requestEye(request: Request, env: HostEnv, ctx: ExecutionContext, session: HostSession, uid?: string) {
  const cookie = getOrCreateCid(request);
  const eye = createEyeRequest({ service: env.EYE, ctx, siteId: 'shop',
    subject: { cid: cookie.cid, ...(uid === undefined ? {} : { uid }) },
    userAttributes: { locale: 'ko' },
    decisions: { secret: env.EYE_DECISION_SECRET, cache: policies, tokens: session.decisionTokens,
      onPrepared: (experimentId, token) => session.setDecisionToken(experimentId, token) },
    onError: error => console.error('Eye integration failed', error) });
  return { eye, finish(response: Response) {
    // Copy headers so immutable upstream responses can also be finalized.
    const headers = new Headers(response.headers);
    if (cookie.setCookie) headers.append('Set-Cookie', cookie.setCookie);
    headers.set('Cache-Control', 'private, no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } };
}

/** The host supplies its own authenticated uid, when available. */
export async function handlePage(request: Request, env: HostEnv, ctx: ExecutionContext, session: HostSession, uid?: string): Promise<Response> {
  const { eye, finish } = requestEye(request, env, ctx, session, uid);
  const selection = await eye.variant(checkout);
  const content = selection.value === 'compact'
    ? '<main>Compact checkout</main>' : '<main>Standard checkout</main>';
  const response = new Response(content, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  selection.expose(); // This SSR response applies the selected variant. Fallback is a no-op.
  eye.track({ name: 'page_view', attributes: { path: new URL(request.url).pathname } });
  return finish(response);
}

/** Invoke from a trusted setup job or administration route, once per definition. */
export async function configure(env: HostEnv, ctx: ExecutionContext): Promise<void> {
  const eye = createEye({ service: env.EYE, ctx, siteId: 'shop' });
  await eye.goals.create('purchase');
  await eye.goals.create('refund');
  await eye.experiments.create({ experimentId: checkout.experimentId, arms: Object.keys(checkout.variants), settings: { minHoldMs: 86_400_000 } });
}

export async function compareLocale(env: HostEnv, ctx: ExecutionContext) {
  const eye = createEye({ service: env.EYE, ctx, siteId: 'shop' }), to = Date.now();
  return eye.analytics.arms({ experimentId: 'checkout', from: to - 7 * 86_400_000, to, groupBy: [{ key: 'locale', type: 'string' }] });
}
