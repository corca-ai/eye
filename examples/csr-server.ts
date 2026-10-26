import { createEyeBrowserServer, type EyeService, type Subject } from '@eye/workers';

interface Env { EYE: EyeService; EYE_DECISION_SECRET: string; EYE_RECEIPT_SECRET: string }
/** Supplied by host auth, never parsed from the JSON body. The stable browser binding must be authenticated by the host (for example a signed HttpOnly cookie). */
export interface BrowserAuth { subject: Subject; browserBinding: string; scope: string }
const allowed = new Set(['checkout']);

/** Mount these two POST routes in the existing authenticated host Worker. */
export async function handleEyeHttp(request: Request, env: Env, ctx: ExecutionContext, auth: BrowserAuth): Promise<Response> {
  const url = new URL(request.url), headers = { 'Cache-Control': 'private, no-store' };
  if (!['/eye/prepare', '/eye/events'].includes(url.pathname)) return new Response('Not found', { status: 404 });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
  // A streamed cap prevents reading an arbitrarily large body before validation.
  if (!request.body) return new Response('Missing body', { status: 400 });
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 48_000) { await reader.cancel(); return new Response('Body too large', { status: 413 }); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const input: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const server = createEyeBrowserServer({ service: env.EYE, ctx, ...auth,
      decisions: { secret: env.EYE_DECISION_SECRET }, receiptSecret: env.EYE_RECEIPT_SECRET,
      onError: error => console.error('Eye CSR failed', error) });
    if (url.pathname === '/eye/prepare') {
      if (typeof input !== 'object' || input === null || !('experimentIds' in input)
        || !Array.isArray(input.experimentIds) || input.experimentIds.length > 20
        || !input.experimentIds.every((id: unknown): id is string => typeof id === 'string' && allowed.has(id))) {
        return Response.json({ error: 'Invalid experiment list' }, { status: 400, headers });
      }
      return Response.json(await server.prepare(input.experimentIds, 'states' in input ? input.states : {}), { headers });
    }
    return Response.json(await server.receive(input), { headers });
  } catch {
    // Queue failures produce non-2xx so the browser retries the same event IDs.
    return Response.json({ error: 'Eye request unavailable' }, { status: 503, headers });
  } finally { reader.releaseLock(); }
}
