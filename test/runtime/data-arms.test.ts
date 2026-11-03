import { ExperimentState } from '../../src/runtime/experiment-state.js';
import { exports, env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext, runInDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { createEye } from '../../src/client.js';
import { createEyeRequest } from '../../src/request.js';
import { createEyeBrowserServer } from '../../src/browser-server.js';
import { DecisionCache } from '../../src/decisions.js';
import type { EventEnvelope } from '../../src/core/types.js';
const secret = 'data-arm-secret-with-at-least-32-bytes';
afterEach(async () => { await reset(); });
async function fixture() {
  const ctx = createExecutionContext(), events: EventEnvelope[] = [];
  const ingest = vi.fn(async (batch: readonly EventEnvelope[]) => { events.push(...batch); });
  const readPolicy = vi.fn((experimentId: string, maxAgeMs?: number) => exports.default.getPublishedPolicy(experimentId, maxAgeMs));
  const service = new Proxy(exports.default, { get(target, property) { return property === 'ingest' ? ingest : property === 'getPublishedPolicy' ? readPolicy : Reflect.get(target, property); } });
  const options = { ctx, service, subject: { cid: 'browser' }, decisions: { secret, cache: new DecisionCache() }, receiptSecret: secret, browserBinding: 'browser', scope: 'anon', defaultArms: { copy: 'control' } };
  const admin = createEye(options); await admin.experiments.create({ experimentId: 'copy', arms: ['control'], settings: { minHoldMs: 0 } });
  await admin.experiments.addArm('copy', { armId: 'b', data: { headline: 'Remote B' } });
  await admin.experiments.pauseArm('copy', 'control');
  await admin.prepare({ subject: options.subject, experimentId: 'copy' });
  return { options, admin, events, readPolicy };
}
const baseline = { headline: 'Host baseline' };
const definition = { experimentId: 'copy', defaultArm: 'control', defaultValue: baseline,
  parse(data: unknown) { if (!data || typeof data !== 'object' || !('headline' in data) || typeof data.headline !== 'string') throw Error('copy'); return { headline: data.headline }; } };
it('retains immutable data across idempotent adds, pause/resume/delete and new policy publications', async () => {
  const f = await fixture();
  const stub = env.SITES.getByName(await f.options.service.getInstallationId());
  await runInDurableObject(stub, (_actor, state) => {
    const experiment = new ExperimentState(state.storage.sql, state.storage.kv, 'copy');
    expect(() => state.storage.transactionSync(() => experiment.addArm({ armId: 'b', data: { headline: 'Different' } }))).toThrow('immutable');
  });
  expect((await f.admin.experiments.addArm('copy', 'b')).arms.find(a => a.armId === 'b')!.data).toEqual({ headline: 'Remote B' });
  await f.admin.experiments.pauseArm('copy', 'b'); await f.admin.experiments.resumeArm('copy', 'b');
  const published = await f.options.service.getPublishedPolicy('copy'); expect(published.armData).toEqual({ b: { headline: 'Remote B' } });
  await f.admin.experiments.deleteArm('copy', 'b');
  await runInDurableObject(stub, (_actor, state) => {
    const experiment = new ExperimentState(state.storage.sql, state.storage.kv, 'copy');
    expect(() => state.storage.transactionSync(() => experiment.addArm('b'))).toThrow('cannot be reused');
  });
  await waitOnExecutionContext(f.options.ctx);
});
it('returns server data without another policy RPC and never includes payload in tracking events or signed state', async () => {
  const f = await fixture(), request = createEyeRequest(f.options), reads = f.readPolicy.mock.calls.length;
  const selected = await request.data(definition); expect(selected.armId).toBe('b'); expect(selected.value.headline).toBe('Remote B');
  selected.expose(); selected.expose(); await waitOnExecutionContext(f.options.ctx);
  expect(f.readPolicy).toHaveBeenCalledTimes(reads);
  expect(f.events).toHaveLength(1); expect(f.events[0]!.event).toMatchObject({ kind: 'exposure', assignment: { armId: 'b' } });
  expect(JSON.stringify(f.events)).not.toContain('Remote B');
  const tokens = await request.state(); expect(atob(tokens.copy!.split('.')[0]!.replaceAll('-', '+').replaceAll('_', '/'))).not.toContain('Remote B');
});
it('sends only selected data in browser snapshots and keeps receipts small, then preserves original identity on receive', async () => {
  const f = await fixture(), server = createEyeBrowserServer(f.options), snapshot = await server.snapshot(['copy']);
  expect(snapshot.choices[0]!.data).toEqual({ headline: 'Remote B' });
  const receiptSize = snapshot.choices[0]!.receipt.length;
  await f.admin.experiments.addArm('copy', { armId: 'large', data: { headline: 'x'.repeat(12000) } });
  await f.admin.experiments.pauseArm('copy', 'b');
  const secondServer = createEyeBrowserServer({ ...f.options, decisions: { secret, cache: new DecisionCache() } });
  const second = await secondServer.prepare(['copy']); expect(second.choices[0]!.data).toEqual({ headline: 'x'.repeat(12000) });
  expect(second.choices[0]!.receipt.length).toBeLessThan(receiptSize + 500);
  await expect(server.receive([{ eventId: 'data-shown', receipt: second.choices[0]!.receipt, occurredAt: second.serverNow }])).resolves.toEqual([{ eventId: 'data-shown', accepted: true }]);
  await waitOnExecutionContext(f.options.ctx); expect(JSON.stringify(f.events)).not.toContain('xxxxxxxx');
});
it('records the host default instead of a rejected data arm and honors disabled experiments', async () => {
  const f = await fixture(); await f.admin.experiments.resumeArm('copy', 'control');
  const published = await f.options.service.getPublishedPolicy('copy');
  const policy = { ...published, arms: published.arms.map(a => ({ ...a, probability: a.armId === 'b' ? 1 : 0 })) };
  const request = createEyeRequest({ ...f.options, decisions: { secret, cache: new DecisionCache(), initialPolicies: [policy] } }), rejected = await request.data({ ...definition, parse() { throw Error('bad content'); } });
  expect(rejected.armId).toBe('control'); expect(rejected.value).toBe(baseline); rejected.expose(); await waitOnExecutionContext(f.options.ctx);
  expect(f.events[0]!.event).toMatchObject({ kind: 'exposure', defaultReason: 'invalid_data', assignment: { armId: 'control', allocation: 'default' } });
  const disabled = await createEyeRequest({ ...f.options, experimentsEnabled: false }).data(definition); expect(disabled.armId).toBeNull(); expect(disabled.expose()).toBeNull();
});
