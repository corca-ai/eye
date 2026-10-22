import { expect, it } from 'vitest';
import { getOrCreateCid } from '../../src/cookie.js';

it('creates a host-only cookie once and reads it on the next request', () => {
  const first = getOrCreateCid(new Request('https://example.com/'));
  expect(first.setCookie).toContain('HttpOnly; SameSite=Lax; Secure');
  const next = getOrCreateCid(new Request('https://example.com/', { headers: { Cookie: `other=x; cid=${first.cid}; session=y` } }));
  expect(next).toEqual({ cid: first.cid, setCookie: null });
});
it('replaces malformed cookie input without failing the request', () => {
  for (const cid of ['%ZZ', '%0d%0aHeader:evil', '']) {
    expect(getOrCreateCid(new Request('https://example.com/', { headers: { Cookie: `cid=${cid}` } })).setCookie).not.toBeNull();
  }
});
it('supports local HTTP without pretending a secure prefix is valid', () => {
  expect(getOrCreateCid(new Request('http://localhost/')).setCookie).not.toContain('; Secure');
  expect(() => getOrCreateCid(new Request('http://localhost/'), { name: '__Host-cid' })).toThrow();
});
