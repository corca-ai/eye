import { afterEach, expect, it, vi } from 'vitest';
import { armData, checkExperimentData, MAX_ARM_DATA_BYTES } from '../../src/core/arm-data.js';
import { parseCreateExperiment } from '../../src/core/events.js';
import { createEyeBrowser } from '../../src/browser.js';
import type { BrowserExposure, BrowserSnapshot, DataDefinition } from '../../src/browser-types.js';

const now = 1_800_000_000_000;
const baseline = { headline: 'Service baseline' };
const definition: DataDefinition<typeof baseline> = { experimentId: 'copy', defaultArm: 'control', defaultValue: baseline,
  parse(data) { if (!data || typeof data !== 'object' || !('headline' in data) || typeof data.headline !== 'string') throw Error('Invalid copy'); return { headline: data.headline }; } };
function snapshot(data: BrowserSnapshot['choices'][number]['data'] = { headline: 'Remote B' }): BrowserSnapshot {
  return { scope: 'anon', serverNow: now, choices: [{ experimentId: 'copy', armId: 'b', receipt: 'policy', applyUntil: now + 10000,
    assignmentId: 'b', observationWindowMs: 1000, ...(data === undefined ? {} : { data }) }], defaults: [
    { experimentId: 'copy', armId: 'control', receipt: 'default', applyUntil: now + 10000, assignmentId: 'control', observationWindowMs: 1000 },
  ] };
}
afterEach(() => vi.useRealTimers());
it('accepts canonical bounded JSON and rejects non-JSON, cycles, accessors, excessive size and nesting', () => {
  const input = { z: [null, false, 2], a: { title: '문구' } };
  expect(armData(input)).toEqual(input); expect(armData(input)).not.toBe(input);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const accessor = Object.defineProperty({}, 'a', { enumerable: true, get() { throw Error('getter ran'); } });
  for (const invalid of [undefined, NaN, Infinity, () => {}, new Date(), cyclic, accessor, Array(1), 'x'.repeat(MAX_ARM_DATA_BYTES + 1)]) expect(() => armData(invalid)).toThrow();
  expect(() => armData({ ['x'.repeat(MAX_ARM_DATA_BYTES + 1)]: 0 })).toThrow();
  expect(() => armData(['x'.repeat(10000), 'y'.repeat(10000)])).toThrow();
  expect(() => armData(Array.from({ length: 4097 }, () => 0))).toThrow();
  let deep: unknown = 1; for (let i = 0; i < 18; i++) deep = [deep]; expect(() => armData(deep)).toThrow();
  expect(() => checkExperimentData(Array.from({ length: 5 }, (_, i) => ({ armId: String(i), data: 'x'.repeat(16000) })))).toThrow('64 KiB');
});
it('normalizes legacy and data definitions and rejects duplicate mixed IDs', () => {
  const base = { experimentId: 'copy', settings: { minHoldMs: 0 } };
  expect(parseCreateExperiment({ ...base, arms: ['control', { armId: 'b', data: { headline: 'B' } }] }).arms).toEqual(['control', { armId: 'b', data: { headline: 'B' } }]);
  expect(parseCreateExperiment({ ...base, arms: [{ armId: 'control' }] }).arms).toEqual(['control']);
  expect(() => parseCreateExperiment({ ...base, arms: ['b', { armId: 'b', data: null }] })).toThrow('unique');
});
it('selects a newly registered data arm without a variants map and records only its receipt', async () => {
  vi.useFakeTimers({ now }); const events: BrowserExposure[] = [], initial = snapshot();
  const eye = createEyeBrowser({ scope: 'anon', initial, send: async batch => { events.push(...batch); return batch.map(e => ({ eventId: e.eventId, accepted: true })); } });
  try {
    const selected = eye.beginView().data(definition); expect(selected.armId).toBe('b'); expect(selected.value).toEqual({ headline: 'Remote B' });
    expect(selected.expose()).toBe(true); expect(selected.expose()).toBe(true); await eye.flush();
    expect(events).toHaveLength(1); expect(events[0]!.receipt).toBe('policy'); expect(JSON.stringify(events)).not.toContain('Remote B');
  } finally { eye.dispose(); }
});
it.each([undefined, null, { headline: 7 }])('uses the local default for missing/invalid data without exposing the failed arm (%j)', async invalid => {
  vi.useFakeTimers({ now }); const events: BrowserExposure[] = [], initial = snapshot();
  if (invalid === undefined) delete initial.choices[0]!.data; else initial.choices[0]!.data = invalid;
  const eye = createEyeBrowser({ scope: 'anon', initial, send: async batch => { events.push(...batch); return batch.map(e => ({ eventId: e.eventId, accepted: true })); } });
  try { const selected = eye.beginView().data(definition); expect(selected.armId).toBe('control'); expect(selected.value).toBe(baseline); selected.expose(); await eye.flush(); expect(events[0]).toMatchObject({ receipt: 'default', defaultReason: 'invalid_data' }); }
  finally { eye.dispose(); }
});
it('uses local default values even for policy-selected control, and stays unassigned without authority', () => {
  vi.useFakeTimers({ now }); const initial = snapshot(); initial.choices[0]!.armId = 'control';
  const eye = createEyeBrowser({ scope: 'anon', initial }), cold = createEyeBrowser({ scope: 'anon' });
  try { expect(eye.beginView().data(definition).value).toBe(baseline); const selected = cold.beginView().data(definition); expect(selected.value).toBe(baseline); expect(selected.armId).toBeNull(); expect(selected.expose()).toBe(false); }
  finally { eye.dispose(); cold.dispose(); }
});
it('bounds data preparation, freezes the occurrence and preserves cached payload against host parser mutation', async () => {
  vi.useFakeTimers({ now }); let release!: (s: BrowserSnapshot) => void;
  const initial = snapshot(); initial.choices = [];
  const eye = createEyeBrowser({ scope: 'anon', initial, prepare: () => new Promise(resolve => { release = resolve; }) });
  try {
    const view = eye.beginView(), waiting = view.dataAsync(definition, { maxWaitMs: 5 }); await vi.advanceTimersByTimeAsync(6);
    expect((await waiting).value).toBe(baseline); release(snapshot()); await vi.advanceTimersByTimeAsync(1);
    expect(view.data(definition).value).toBe(baseline);
    const mutating = { ...definition, parse(data: unknown) { if (data && typeof data === 'object' && 'headline' in data) data.headline = 'mutated'; return baseline; } };
    eye.beginView().data(mutating); expect(eye.beginView().data(definition).value.headline).toBe('Remote B');
    const disposed = eye.beginView(); disposed.dispose(); expect(disposed.data(definition).value).toBe(baseline);
  } finally { eye.dispose(); }
});
it('preserves explicit undefined values from code variants and data parsers', () => {
  vi.useFakeTimers({ now }); const eye = createEyeBrowser({ scope: 'anon', initial: snapshot() });
  try {
    const code = eye.beginView().variant<string | undefined>({ experimentId: 'copy', variants: { b: undefined }, fallback: 'fallback' });
    expect(code.armId).toBe('b'); expect(code.value).toBeUndefined();
    const data = eye.beginView().data<typeof baseline | undefined>({ ...definition, parse: () => undefined });
    expect(data.armId).toBe('b'); expect(data.value).toBeUndefined();
  } finally { eye.dispose(); }
});
