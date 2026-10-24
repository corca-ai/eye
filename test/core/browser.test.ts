import { afterEach, expect, it, vi } from 'vitest';
import { createEyeBrowser } from '../../src/browser.js';
import type { BrowserSnapshot, BrowserExposure } from '../../src/browser-types.js';
const definition = { experimentId: 'checkout', variants: { compact: 'small' }, fallback: 'standard' };
function snapshot(scope = 'a'): BrowserSnapshot {
  return { scope, serverNow: Date.now(), choices: [{ experimentId: 'checkout', armId: 'compact', receipt: 'opaque', applyUntil: Date.now() + 300_000 }] };
}
afterEach(() => { vi.useRealTimers(); });
it('renders fallback immediately while preparation hangs and never changes an existing view', async () => {
  vi.useFakeTimers();
  let complete!: (value: BrowserSnapshot) => void;
  const prepare = vi.fn(() => new Promise<BrowserSnapshot>(resolve => { complete = resolve; }));
  const client = createEyeBrowser({ scope: 'a', prepare });
  const view = client.beginView(), first = view.variant(definition);
  expect(first.value).toBe('standard'); expect(first.expose()).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(prepare).toHaveBeenCalledTimes(1);
  complete(snapshot()); await vi.advanceTimersByTimeAsync(1);
  expect(view.variant(definition)).toBe(first);
  expect(client.beginView().variant(definition).value).toBe('small');
  client.dispose();
});
it('does not expose prefetch/disposed views; repeated display and retries retain one event ID', async () => {
  vi.useFakeTimers();
  const batches: BrowserExposure[][] = [];
  const send = vi.fn(async (events: BrowserExposure[]) => {
    batches.push(events);
    if (batches.length === 1) throw new Error('network');
    return events.map(e => ({ eventId: e.eventId, accepted: true }));
  });
  const client = createEyeBrowser({ scope: 'a', initial: snapshot(), send });
  const canceled = client.beginView(), ignored = canceled.variant(definition); canceled.dispose();
  expect(ignored.expose()).toBe(false);
  const view = client.beginView(), selected = view.variant(definition);
  expect(send).not.toHaveBeenCalled(); expect(selected.expose()).toBe(true); expect(selected.expose()).toBe(true);
  const flushing = client.flush(); await vi.advanceTimersByTimeAsync(3001); await flushing;
  expect(batches).toHaveLength(2); expect(batches[0]).toEqual(batches[1]); expect(batches[0]).toHaveLength(1);
  client.dispose();
});
it('invalidates old selections on authentication changes but keeps already emitted events', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async (events: BrowserExposure[]) => events.map(e => ({ eventId: e.eventId, accepted: true })));
  const client = createEyeBrowser({ scope: 'a', initial: snapshot(), send });
  const view = client.beginView(), displayed = view.variant(definition), unused = view.variant(definition, 'other');
  displayed.expose(); client.setScope('b');
  expect(unused.expose()).toBe(false); expect(view.variant(definition).armId).toBeNull();
  await client.flush(); expect(send.mock.calls[0]![0]).toHaveLength(1);
  client.dispose();
});
it('rejects late preparation from a previous authentication epoch', async () => {
  vi.useFakeTimers();
  let complete!: (value: BrowserSnapshot) => void;
  const client = createEyeBrowser({ scope: 'a', prepare: () => new Promise(resolve => { complete = resolve; }) });
  client.beginView().variant(definition); await vi.advanceTimersByTimeAsync(1);
  client.setScope('b'); complete(snapshot('a')); await vi.advanceTimersByTimeAsync(1);
  expect(client.beginView().variant(definition).value).toBe('standard'); client.dispose();
});
it('does not emit after expiry or for unknown arms, and limits queue growth', async () => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const client = createEyeBrowser({ scope: 'a', initial: snapshot(), onError });
  expect(client.beginView().variant({ ...definition, variants: { other: 'other' } }).expose()).toBe(false);
  for (let i = 0; i < 100; i++) expect(client.beginView().variant(definition).expose()).toBe(true);
  expect(client.beginView().variant(definition).expose()).toBe(false);
  const held = client.beginView().variant(definition);
  vi.setSystemTime(Date.now() + 300_001); expect(held.expose()).toBe(false);
  expect(onError).toHaveBeenCalled(); client.dispose();
});

it('flush joins an active send and drains every bounded batch before disposal', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const ids: string[] = [];
  const send = vi.fn(async (events: BrowserExposure[]) => {
    if (ids.length === 0) await new Promise<void>(resolve => { release = resolve; });
    ids.push(...events.map(e => e.eventId));
    return events.map(e => ({ eventId: e.eventId, accepted: true }));
  });
  const client = createEyeBrowser({ scope: 'a', initial: snapshot(), send });
  for (let i = 0; i < 60; i++) client.beginView().variant(definition).expose();
  const first = client.flush(), second = client.flush();
  expect(first).toBe(second); expect(ids).toHaveLength(0);
  release(); await second; client.dispose();
  expect(new Set(ids).size).toBe(60); expect(send).toHaveBeenCalledTimes(2);
});

it('flush drops events that cannot fit including array framing instead of spinning at the byte boundary', async () => {
  vi.useFakeTimers();
  for (const size of [15_998, 15_999, 16_000]) {
    const initial = snapshot();
    const overhead = new TextEncoder().encode(JSON.stringify({ eventId: 'x'.repeat(36), receipt: '', occurredAt: initial.serverNow })).length + 1;
    initial.choices[0]!.receipt = 'x'.repeat(size - overhead);
    const send = vi.fn(async (events: BrowserExposure[]) => events.map(e => ({ eventId: e.eventId, accepted: true })));
    const onError = vi.fn(), client = createEyeBrowser({ scope: 'a', initial, send, onError });
    client.beginView().variant(definition).expose();
    await client.flush(); client.dispose();
    expect(send).toHaveBeenCalledTimes(size === 15_998 ? 1 : 0);
    expect(onError).toHaveBeenCalledTimes(size === 15_998 ? 0 : 1);
  }
});

it('preserves a newly exposed sample when an older preparation response arrives', async () => {
  vi.useFakeTimers();
  const initial = snapshot();
  Object.assign(initial.choices[0]!, { assignmentId: 'assignment', observationWindowMs: 86_400_000, applyUntil: Date.now() + 50_000 });
  let complete!: (value: BrowserSnapshot) => void;
  const prepare = vi.fn(() => new Promise<BrowserSnapshot>(resolve => { complete = resolve; }));
  const events: BrowserExposure[] = [];
  const client = createEyeBrowser({ scope: 'a', initial, prepare, send: async batch => { events.push(...batch); return batch.map(e => ({ eventId: e.eventId, accepted: true })); } });
  const selection = client.beginView().variant(definition);
  await vi.advanceTimersByTimeAsync(1);
  selection.expose();
  const stale = snapshot(); Object.assign(stale.choices[0]!, { assignmentId: 'replacement', observationWindowMs: 86_400_000 });
  complete(stale); await vi.advanceTimersByTimeAsync(1);
  client.beginView().variant(definition).expose(); await client.flush();
  expect(events).toHaveLength(2); expect(events[0]!.sample).toEqual(events[1]!.sample);
  await vi.advanceTimersByTimeAsync(5000);
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(prepare.mock.calls[1]).toBeDefined();
  client.dispose();
});

it('retains preparation state across reloads without requiring browser storage', async () => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
  const initial = snapshot(); Object.assign(initial.choices[0]!, { assignmentId: 'assignment', observationWindowMs: 86_400_000 });
  const first = createEyeBrowser({ scope: 'a', storage, initial });
  first.beginView().variant(definition).expose(); first.dispose();
  const prepare = vi.fn(async () => snapshot());
  const next = createEyeBrowser({ scope: 'a', storage, prepare });
  next.beginView().variant(definition); await vi.advanceTimersByTimeAsync(1);
  expect(prepare.mock.calls[0]).toEqual([['checkout'], expect.objectContaining({ checkout: expect.objectContaining({ sample: expect.objectContaining({ sampleId: expect.any(String) }) }) })]);
  next.dispose();
});
