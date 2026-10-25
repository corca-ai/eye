import { invariant } from './core/errors.js';

export interface CidCookieOptions {
  /** Host-only ASCII HTTP token name. Defaults to `cid`. */
  readonly name?: string;
  /** Lifetime in seconds; this option follows HTTP cookie units. Defaults to one year. */
  readonly maxAgeSeconds?: number;
}
export interface CidCookie {
  readonly cid: string;
  /** Append to Set-Cookie only when non-null; never replace the host's other cookies. */
  readonly setCookie: string | null;
}

/** cid가 없거나 잘못됐으면 UUID와 Set-Cookie를 만든다. 기존 쿠키면 setCookie=null. Path=/, HttpOnly, SameSite=Lax, HTTPS에서 Secure를 사용한다. */
export function getOrCreateCid(request: Request, options: CidCookieOptions = {}): CidCookie {
  const name = options.name ?? 'cid';
  const maxAge = options.maxAgeSeconds ?? 31_536_000;
  invariant(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name), 'invalid_input', 'Invalid cookie name');
  invariant(Number.isSafeInteger(maxAge) && maxAge > 0, 'invalid_input', 'maxAgeSeconds must be a positive integer');
  const secure = new URL(request.url).protocol === 'https:';
  invariant(secure || (!name.startsWith('__Host-') && !name.startsWith('__Secure-')), 'invalid_input', 'Secure cookie prefixes require HTTPS');
  for (const cookie of (request.headers.get('Cookie') ?? '').split(';')) {
    const separator = cookie.indexOf('=');
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    try {
      const cid = decodeURIComponent(cookie.slice(separator + 1).trim());
      if (cid.length > 0 && cid.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(cid)) return { cid, setCookie: null };
    } catch { /* An invalid cookie is replaced; it never breaks a service request. */ }
  }
  const cid = crypto.randomUUID();
  return { cid, setCookie: `${name}=${cid}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}` };
}
