import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { experimentKey, subjectKey } from '../../src/core/validation.js';
import { observationShard, shardKey } from '../../src/runtime/shard.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(count = 1) {
  const siteId = crypto.randomUUID(), experimentId = 'batch';
  const experiment = env.EXPERIMENTS.getByName(experimentKey(siteId, experimentId));
  await experiment.create({ experimentId, arms: ['a'], settings: { minHoldMs: 0, observationWindowMs: 600_000 } });
  const subjects = Array.from({ length: 1000 }, (_, i) => ({ cid: `browser-${i}` }))
    .filter(subject => observationShard(subjectKey(siteId, subject)) === 0).slice(0, count);
  expect(subjects).toHaveLength(count);
  const users = [];
  for (const subject of subjects) {
    const user = env.SUBJECTS.getByName(subjectKey(siteId, subject));
    const decision = await user.decide(siteId, subject, experimentId);
    if (decision.status !== 'assigned') throw new Error('Missing assignment');
    await user.ingest({ siteId, receivedAt: Date.now(), event: { kind: 'exposure', eventId: crypto.randomUUID(), subject,
      occurredAt: decision.assignment.assignedAt, assignment: decision.assignment } });
    users.push(user);
    cleanups.push(async () => { await runInDurableObject(user, async (_instance, state) => { await state.storage.deleteAlarm(); }); });
  }
  const shard = env.OBSERVATIONS.getByName(shardKey(siteId, experimentId, 0));
  for (const target of [experiment, shard]) cleanups.push(async () => { await runInDurableObject(target, async (_instance, state) => { await state.storage.deleteAlarm(); }); });
  return { siteId, experiment, shard, users };
}
it('coalesces many subjects into one scheduled statistics publication', async () => {
  const f = await fixture(8);
  for (const user of f.users) await user.flush();
  expect((await f.experiment.getPolicy()).statsAsOf).toBeNull();
  const before = await runInDurableObject(f.shard, (_instance, state) => [...state.storage.kv.list({ prefix: 'dirty:' })].length);
  expect(before).toBe(1);
  await runInDurableObject(f.shard, async (instance, state) => { await state.storage.deleteAlarm(); await instance.alarm(); });
  const policy = await f.experiment.getPolicy();
  expect(policy.statsAsOf).not.toBeNull();
  expect(policy.arms[0]?.pending).toBe(8);
  expect(policy.arms[0]?.weight).toBe(0);
  await runInDurableObject(f.shard, (_instance, state) => { expect([...state.storage.kv.list({ prefix: 'dirty:' })].length).toBe(0); });
});
it('retains a dirty update until the next publication interval', async () => {
  const f = await fixture();
  await f.users[0]!.flush();
  await runInDurableObject(f.shard, async (instance, state) => {
    await state.storage.deleteAlarm();
    const observation = JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM observations').one().data);
    await instance.alarm();
    const publishedAt = state.storage.kv.get<number>('lastPublishedAt')!;
    await instance.apply(f.siteId, { ...observation, revision: observation.revision + 1 });
    await instance.alarm();
    expect(state.storage.kv.get('lastPublishedAt')).toBe(publishedAt);
    expect([...state.storage.kv.list({ prefix: 'dirty:' })]).toHaveLength(1);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(publishedAt + 60_001);
    try { await instance.alarm(); } finally { clock.mockRestore(); }
    expect([...state.storage.kv.list({ prefix: 'dirty:' })]).toHaveLength(0);
  });
});
it('exports analytics and retains learning effects when a statistics shard is unavailable', async () => {
  const f = await fixture();
  await runInDurableObject(f.shard, instance => {
    vi.spyOn(Object.getPrototypeOf(instance) as typeof instance, 'apply').mockRejectedValue(new Error('statistics unavailable'));
  });
  try {
    const message = await runInDurableObject(f.users[0]!, async instance => {
      try { await instance.flush(); return null; } catch (error) { return String(error); }
    });
    expect(message).toContain('statistics unavailable');
    const retained = await runInDurableObject(f.users[0]!, (_instance, state) => state.storage.sql.exec<{ kind: string }>('SELECT kind FROM outbox').toArray());
    expect(retained).toEqual([{ kind: 'observation' }]);
  } finally {
    await runInDurableObject(f.shard, instance => { vi.mocked((Object.getPrototypeOf(instance) as typeof instance).apply).mockRestore(); });
  }
  await f.users[0]!.flush();
  await runInDurableObject(f.users[0]!, (_instance, state) => { expect(state.storage.sql.exec('SELECT id FROM outbox').toArray()).toEqual([]); });
});

it('does not poll an overdue settlement every second during publication cooldown', async () => {
  const f = await fixture();
  await f.users[0]!.flush();
  await runInDurableObject(f.shard, async (instance, state) => {
    await state.storage.deleteAlarm();
    const settlement = state.storage.sql.exec<{ settle_at: number }>('SELECT settle_at FROM observations').one().settle_at;
    let now = settlement - 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await instance.alarm();
      const publishedAt = state.storage.kv.get<number>('lastPublishedAt')!;
      now = settlement + 1;
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBe(publishedAt + 60_000);
      expect(state.storage.kv.get('lastPublishedAt')).toBe(publishedAt);
      now = publishedAt + 60_001;
      await instance.alarm();
      expect(state.storage.sql.exec<{ count: number }>('SELECT count FROM pending_counts').one().count).toBe(0);
      expect([...state.storage.kv.list({ prefix: 'dirty:' })]).toHaveLength(0);
    } finally { clock.mockRestore(); await state.storage.deleteAlarm(); }
  });
  expect((await f.experiment.getPolicy()).arms[0]?.pending).toBe(0);
});
