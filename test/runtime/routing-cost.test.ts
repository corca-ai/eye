import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, evictDurableObject, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { createEye } from '../../src/client.js';
import { identityKey } from '../../src/runtime/identity.js';
import type { IdentityRegistry } from '../../src/runtime/identity.js';
import type { SubjectObject } from '../../src/runtime/subject.js';

it('measures repeated authenticated routing after ownership and transfer have completed', async () => {
  const siteId = crypto.randomUUID(), ctx = createExecutionContext();
  const eye = createEye({ siteId, ctx, service: exports.default, decisions: { secret: 'routing-test-secret-longer-than-32-bytes' } });
  await eye.experiments.create({ experimentId: 'exp', arms: ['a'], settings: { minHoldMs: 86_400_000 } });
  const subject = { cid: 'browser', uid: 'user' };
  const first = await eye.prepare({ subject, experimentId: 'exp' });
  if (first.decision.status !== 'assigned' || !first.decision.routingKey) throw new Error('Missing decision');
  const target = env.SUBJECTS.getByName(first.decision.routingKey);
  const uid = env.IDENTITIES.getByName(identityKey(siteId, 'uid', subject.uid));
  const browser = env.IDENTITIES.getByName(identityKey(siteId, 'cid', subject.cid));
  await evictDurableObject(browser);
  const counts = { uidHome: 0, claimOwner: 0, transferTo: 0 };
  await runInDurableObject(uid, instance => {
    const prototype = Object.getPrototypeOf(instance) as IdentityRegistry, original = prototype.uidHome;
    vi.spyOn(prototype, 'uidHome').mockImplementation(function (this: IdentityRegistry, ...args) {
      if (args[0] === siteId) counts.uidHome++;
      return original.apply(this, args);
    });
  });
  await runInDurableObject(target, instance => {
    const prototype = Object.getPrototypeOf(instance) as SubjectObject;
    for (const name of ['claimOwner', 'transferTo'] as const) {
      if (name === 'claimOwner') {
        const original = prototype.claimOwner;
        vi.spyOn(prototype, name).mockImplementation(function (this: SubjectObject, ...args) { if (args[0] === siteId) counts.claimOwner++; return original.apply(this, args); });
      } else {
        const original = prototype.transferTo;
        vi.spyOn(prototype, name).mockImplementation(function (this: SubjectObject, ...args) { if (args[0] === siteId) counts.transferTo++; return original.apply(this, args); });
      }
    }
  });
  try {
    for (let i = 0; i < 20; i++) {
      const next = await eye.prepare({ subject, experimentId: 'exp' });
      expect(next.decision.status === 'assigned' && next.decision.assignment.assignmentId).toBe(first.decision.assignment.assignmentId);
    }
    expect(counts).toEqual({ uidHome: 0, claimOwner: 0, transferTo: 0 });
  } finally {
    await runInDurableObject(uid, instance => { vi.mocked((Object.getPrototypeOf(instance) as IdentityRegistry).uidHome).mockRestore(); });
    await runInDurableObject(target, instance => {
      const prototype = Object.getPrototypeOf(instance) as SubjectObject;
      vi.mocked(prototype.claimOwner).mockRestore(); vi.mocked(prototype.transferTo).mockRestore();
    });
    await waitOnExecutionContext(ctx);
  }
});

it('caches routing only after a successful transfer and transfers a new epoch after logout', async () => {
  const siteId = crypto.randomUUID(), cid = 'browser', uid = 'known';
  const browser = env.IDENTITIES.getByName(identityKey(siteId, 'cid', cid));
  const home = await env.IDENTITIES.getByName(identityKey(siteId, 'uid', uid)).uidHome(siteId, uid);
  const at = Date.now();
  const sourceName = await browser.anonymousHome(siteId, cid, at);
  const source = env.SUBJECTS.getByName(sourceName);
  await runInDurableObject(source, instance => {
    const prototype = Object.getPrototypeOf(instance) as SubjectObject, original = prototype.transferTo;
    vi.spyOn(prototype, 'transferTo').mockImplementation(function (this: SubjectObject, ...args) {
      if (args[0] === siteId) return Promise.reject(new Error('transfer unavailable'));
      return original.apply(this, args);
    });
  });
  try {
    const message = await runInDurableObject(browser, async instance => {
      try { await instance.authenticatedHome(siteId, cid, uid, at); return null; } catch (error) { return String(error); }
    });
    expect(message).toContain('transfer unavailable');
    await runInDurableObject(browser, (_instance, state) => { expect(state.storage.kv.get('readyRoute')).toBeUndefined(); });
  } finally {
    await runInDurableObject(source, instance => { vi.mocked((Object.getPrototypeOf(instance) as SubjectObject).transferTo).mockRestore(); });
  }
  expect(await browser.authenticatedHome(siteId, cid, uid, at)).toBe(home);
  await runInDurableObject(source, (_instance, state) => { expect(state.storage.kv.get('transferReady')).toBe(true); });
  await browser.logout(siteId, cid, at + 1);
  const newSourceName = await browser.anonymousHome(siteId, cid, at + 2);
  expect(newSourceName).not.toBe(sourceName);
  expect(await browser.authenticatedHome(siteId, cid, uid, at + 2)).toBe(home);
  await runInDurableObject(env.SUBJECTS.getByName(newSourceName), (_instance, state) => { expect(state.storage.kv.get('transferReady')).toBe(true); });
  expect(await browser.authenticatedHome(siteId, cid, 'other-user', at + 3)).not.toBe(home);
});

it('accepts a trusted automatic identity receipt ahead of the receiving DO clock without accepting external future events', async () => {
  const siteId = crypto.randomUUID(), subject = { cid: 'clock', uid: 'user' }, at = Date.now();
  const timeline = env.SUBJECTS.getByName(JSON.stringify([siteId, 'identity-timeline', subject.cid]));
  await runInDurableObject(timeline, async (instance, state) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
    const input = { siteId, receivedAt: at + 100, event: { kind: 'identify' as const, eventId: 'internal', occurredAt: at, subject } };
    try {
      await instance.linkIdentity(input, true);
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM identity_links').one().n).toBe(1);
      let rejected = false;
      try { await instance.linkIdentity({ ...input, event: { ...input.event, eventId: 'external' } }); }
      catch (error) { rejected = error instanceof Error && error.message.includes('future'); }
      expect(rejected).toBe(true);
    } finally { clock.mockRestore(); await state.storage.deleteAlarm(); }
  });
});
