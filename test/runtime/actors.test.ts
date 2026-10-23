import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { experimentKey } from '../../src/core/validation.js';
import { observationShard, shardKey } from '../../src/runtime/shard.js';
import type { Observation } from '../../src/core/types.js';
import { addSample, emptyMoments } from '../../src/core/moments.js';

function actor() {
  const site = crypto.randomUUID(), experimentId = 'checkout';
  return { site, experimentId, stub: env.EXPERIMENTS.getByName(experimentKey(site, experimentId)) };
}
const config = { minHoldMs: 0, observationWindowMs: 1000, allowedLatenessMs: 0 };

describe('experiment coordination in workerd', () => {
  it('serializes concurrent reservations, records exact probabilities and persists across eviction', async () => {
    const { stub } = actor();
    await stub.create({ experimentId: 'checkout', arms: ['a', 'b'], settings: config });
    const requests = Array.from({ length: 20 }, () => crypto.randomUUID());
    const assignments = await Promise.all(requests.map(key => stub.reserve(key, Date.now())));
    expect(assignments.every(a => a !== null)).toBe(true);
    const policy = await stub.getPolicy();
    expect(policy.arms.reduce((n, a) => n + a.pending, 0)).toBe(20);
    expect(assignments.every(a => a!.probability > 0 && a!.probability <= 1)).toBe(true);
    const first = assignments[0]!;
    await evictDurableObject(stub);
    expect(await stub.reserve(requests[0]!, Date.now())).toEqual(first);
    expect((await stub.getPolicy()).arms.reduce((n, a) => n + a.pending, 0)).toBe(20);
  });
  it('merges trusted cross-object snapshots on a common clock without growing future weights', async () => {
    const { stub } = actor();
    await stub.create({ experimentId: 'checkout', arms: ['a'], settings: { ...config, learningHalfLifeMs: 1000 } });
    const now = Date.now(), ahead = now + 10_000;
    await stub.acceptSnapshot({ generation: 1, shard: 0, sequence: 1, asOf: now,
      moments: { a: addSample(emptyMoments(now), 100) }, pending: {}, releaseReservations: [] });
    await stub.acceptSnapshot({ generation: 1, shard: 1, sequence: 1, asOf: ahead,
      moments: { a: addSample(emptyMoments(ahead), 200) }, pending: {}, releaseReservations: [] });
    const policy = await stub.getPolicy();
    expect(policy.asOf).toBe(ahead);
    expect(policy.arms[0]?.weight).toBeCloseTo(1 + 2 ** -10);
    expect(policy.arms[0]?.meanReward).toBeCloseTo((200 + 100 * 2 ** -10) / (1 + 2 ** -10));
    await evictDurableObject(stub);
    expect((await stub.getPolicy()).arms[0]?.weight).toBeCloseTo(1 + 2 ** -10);
  });
  it('excludes stopped arms immediately and preserves prior statistics when adding arms', async () => {
    const { stub } = actor();
    await stub.create({ experimentId: 'checkout', arms: ['a'], settings: config });
    expect((await stub.reserve('first', Date.now()))?.armId).toBe('a');
    await stub.setArmStatus('a', 'paused');
    expect(await stub.reserve('after-stop', Date.now())).toBeNull();
    expect(await stub.reserve('first', Date.now())).toBeNull();
    await stub.addArm('b');
    expect((await stub.reserve('new-arm', Date.now()))?.armId).toBe('b');
    expect((await stub.getConfig()).generation).toBe(1);
  });
  it('expires reservations after a lost exposure without turning them into reward samples', async () => {
    const { stub } = actor();
    await stub.create({ experimentId: 'checkout', arms: ['a'], settings: config });
    await stub.reserve('unseen', Date.now());
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE reservations SET expires_at = ? WHERE id = 'unseen'", Date.now() - 1);
    });
    const policy = await stub.getPolicy();
    expect(policy.arms[0]?.pending).toBe(0);
    expect(policy.arms[0]?.weight).toBe(0);
  });
});

describe('observation shards', () => {
  it('deduplicates revisions and absolute snapshots; late corrections preserve sample count', async () => {
    const { site, experimentId, stub } = actor();
    await stub.create({ experimentId, arms: ['a'], settings: config });
    const subject = JSON.stringify([site, 'uid', 'u']);
    const shard = env.OBSERVATIONS.getByName(shardKey(site, experimentId, observationShard(subject)));
    const endAt = Date.now() - 10;
    const observation: Observation = {
      observationId: 'o1', assignmentId: 'assign', subjectKey: subject, experimentId, armId: 'a', generation: 1,
      revision: 1, startAt: endAt - 1000, endAt, status: 'complete', reward: 100, attributes: {},
    };
    expect(await shard.apply(site, observation)).toBe(true);
    expect(await shard.apply(site, observation)).toBe(false);
    await shard.publish();
    await shard.publish();
    let policy = await stub.getPolicy();
    expect(policy.arms[0]?.meanReward).toBeCloseTo(100);
    expect(policy.arms[0]?.weight).toBeCloseTo(1, 5);
    await shard.apply(site, { ...observation, reward: -40, revision: 2 });
    await shard.apply(site, observation);
    await shard.publish();
    policy = await stub.getPolicy();
    expect(policy.arms[0]?.meanReward).toBeCloseTo(-40);
    expect(policy.arms[0]?.weight).toBeCloseTo(1, 5);
    await evictDurableObject(shard);
    expect(await shard.apply(site, observation)).toBe(false);
    await shard.apply(site, { ...observation, revision: 3, status: 'interrupted', interruptReason: 'identity' });
    await shard.publish();
    expect((await stub.getPolicy()).arms[0]?.weight).toBe(0);
  });
});

describe('goal lifecycle', () => {
  it('uses event time and retains history after deleting a goal', async () => {
    const site = env.SITES.getByName(crypto.randomUUID());
    const created = await site.createGoal('purchase');
    expect(await site.goalStatusAt('purchase', created.createdAt - 1)).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 2));
    const paused = await site.setGoalStatus('purchase', 'paused');
    expect(await site.goalStatusAt('purchase', created.createdAt)).toBe('active');
    expect(await site.goalStatusAt('purchase', paused.changedAt)).toBe('paused');
    await site.setGoalStatus('purchase', 'active');
    const deleted = await site.setGoalStatus('purchase', 'deleted');
    expect(await site.goalStatusAt('purchase', deleted.changedAt)).toBe('deleted');
    expect(await site.goalStatusAt('purchase', created.createdAt)).toBe('active');
    // Upstream RPC test instrumentation leaks handled rejections (#14736).
    // Assert this rejection inside the real DO, keeping unrelated errors fatal.
    await runInDurableObject(site, instance => {
      expect(() => instance.createGoal('purchase')).toThrow('cannot be reused');
    });
  });
});

it('preserves idempotent creation of an experiment stored before correctionWindowMs existed', async () => {
  const { stub } = actor();
  const input = { experimentId: 'checkout', arms: ['a'], settings: config };
  await stub.create(input);
  await runInDurableObject(stub, (instance, state) => {
    const definition = state.storage.kv.get<{ settings: Record<string, unknown> }>('definition')!;
    delete definition.settings.correctionWindowMs;
    state.storage.kv.put('definition', definition);
    const stored = state.storage.kv.get<{ settings: Record<string, unknown> }>('config')!;
    delete stored.settings.correctionWindowMs;
    state.storage.kv.put('config', stored);
    expect(instance.create(input).settings.correctionWindowMs).toBeUndefined();
  });
});
