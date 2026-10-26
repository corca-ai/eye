import { createEye, createEyeRequest, DecisionCache, getOrCreateCid, type EyeService } from '@eye/workers';
import { checkout } from './host.js';

interface Env { EYE: EyeService; EYE_DECISION_SECRET: string }
const cache = new DecisionCache();

/** scope is an opaque host-auth session epoch, rotated on login/logout/account switch.
 * It may live in the host's signed auth cookie; no server-side session lookup is required.
 * Never use uid alone: a later login to the same account must have a new scope.
 */
async function tokenCookieName(scope: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope));
  return `eye_checkout_${Array.from(new Uint8Array(digest).slice(0, 16), b => b.toString(16).padStart(2, '0')).join('')}`;
}
function readCookie(request: Request, name: string) {
  return (request.headers.get('Cookie') ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
}

/** Mount only at GET /checkout and POST /eye/prepare-checkout, after host authentication.
 * A page-load browser fetch calls the preparation route without blocking page rendering.
 */
export async function cookieCheckout(request: Request, env: Env, ctx: ExecutionContext, scope: string, uid?: string): Promise<Response> {
  const url = new URL(request.url);
  const preparing = url.pathname === '/eye/prepare-checkout';
  if (url.pathname !== '/checkout' && !preparing) return new Response('Not found', { status: 404 });
  if (request.method !== (preparing ? 'POST' : 'GET')) return new Response('Method not allowed', { status: 405 });
  if (preparing && request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
  const cookie = getOrCreateCid(request), name = await tokenCookieName(scope);
  const subject = { cid: cookie.cid, ...(uid === undefined ? {} : { uid }) };
  const token = readCookie(request, name);
  const options = { service: env.EYE, ctx,
    decisions: { secret: env.EYE_DECISION_SECRET, cache, tokens: token ? { checkout: token } : {} },
    onError: (error: unknown) => console.error('Eye integration failed', error) };
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  if (cookie.setCookie) headers.append('Set-Cookie', cookie.setCookie);
  if (preparing) {
    try {
      const prepared = await createEye(options).prepare({ subject, experimentId: checkout.experimentId });
      // One bounded cookie per experiment and auth epoch. Signed payload is opaque to the host.
      if (prepared.token && prepared.token.length > 3500) throw new Error('Decision token exceeds cookie budget');
      const seconds = prepared.token ? 60 * 24 * 3600 : 0;
      headers.append('Set-Cookie', `${name}=${prepared.token ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${url.protocol === 'https:' ? '; Secure' : ''}`);
      return Response.json({ retryAfterMs: seconds > 0 ? Math.max(1000, Math.min(240_000, Math.floor((prepared.reuseUntil - Date.now()) * 0.8))) : 30_000 }, { headers });
    } catch (error) {
      options.onError(error);
      return Response.json({ retryAfterMs: 30_000 }, { status: 503, headers });
    }
  }
  const eye = createEyeRequest({ ...options, subject });
  const selection = await eye.variant(checkout);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  selection.expose();
  eye.track({ name: 'page_view', attributes: { path: url.pathname } });
  try {
    const state = await eye.state();
    if (state.checkout && state.checkout.length > 3500) throw new Error('Decision token exceeds cookie budget');
    if (state.checkout) headers.append('Set-Cookie', `${name}=${state.checkout}; Path=/; HttpOnly; SameSite=Lax; Max-Age=5184000${url.protocol === 'https:' ? '; Secure' : ''}`);
  } catch (error) { options.onError(error); }
  return new Response(selection.value === 'compact' ? '<main>Compact checkout</main>' : '<main>Standard checkout</main>', { headers });
}
