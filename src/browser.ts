import { DEFAULT_POLICY_FRESH_MS } from './policy-timing.js';
import type { VariantDefinition } from './browser-types.js';
import type { BrowserSnapshot, BrowserExposure, BrowserEventResult, BrowserState } from './browser-types.js';
export type { BrowserSnapshot, BrowserExposure, BrowserEventResult, BrowserState } from './browser-types.js';
export interface BrowserOptions {
  scope: string;
  initial?: BrowserSnapshot;
  /** Host POST endpoints. Same origin by default; authentication stays in host cookies. */
  prepareUrl?: string;
  eventsUrl?: string;
  /** Defaults to tab sessionStorage. A custom adapter may retain state across reloads. */
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
  onError?: (error: unknown) => void;
  /** Optional transport adapters for existing data APIs and tests. */
  prepare?: (experiments: string[], states: Readonly<Record<string, BrowserState>>) => Promise<BrowserSnapshot>;
  send?: (events: BrowserExposure[]) => Promise<BrowserEventResult[]>;
}
export interface BrowserSelection<T> {
  readonly value: T;
  readonly armId: string | null;
  /** True means queued locally, not delivered. Fallback/disposed/expired selections return false. */
  expose(): boolean;
}
export interface BrowserView {
  variant<T>(definition: VariantDefinition<T>, placement?: string): BrowserSelection<T>;
  dispose(): void;
}
export interface EyeBrowser {
  setScope(scope: string): void;
  beginView(): BrowserView;
  flush(): Promise<void>;
  dispose(): void;
}
/** Browser-only, framework-independent client. No Worker bindings or server secrets in this entry point. */
export function createEyeBrowser(options: BrowserOptions): EyeBrowser {
  let scope = options.scope, generation = 0, stopped = false;
  let ready = new Map<string, { choice: BrowserSnapshot['choices'][number]; received: number; receivedWall: number; serverNow: number; safetyMs: number }>();
  let states = new Map<string, BrowserState>();
  let storage = options.storage;
  try { storage ??= (globalThis as unknown as { sessionStorage?: BrowserOptions['storage'] }).sessionStorage; } catch { /* Storage can be disabled by browser policy. */ }
  const samples = new Map<string, NonNullable<BrowserState['sample']>>();
  const storageKey = () => `eye/browser/v2/${scope}`;
  const save = () => { try { storage?.setItem(storageKey(), JSON.stringify(Object.fromEntries(states))); } catch (error) { report(error); } };
  try {
    const saved = storage?.getItem(storageKey());
    if (saved && saved.length <= 2_000_000) {
      const raw: unknown = JSON.parse(saved);
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        for (const [id, value] of Object.entries(raw).slice(0, 1000)) {
          if (typeof value === 'object' && value !== null && 'receipt' in value && typeof value.receipt === 'string') states.set(id, value as BrowserState);
        }
      }
    }
  } catch { /* Storage unavailable/corrupt: cold preparation uses a new context. */ }
  const wanted = new Set<string>();
  let nextPrepareAt = 0;
  let preparing = false, prepareTimer: ReturnType<typeof setTimeout> | undefined;
  let sendTimer: ReturnType<typeof setTimeout> | undefined, sending = false;
  let activeFlush: Promise<void> | undefined;
  let retryAt = 0;
  let wakeDrain: (() => void) | undefined;
  const queue: { event: BrowserExposure; tries: number; queuedAt: number }[] = [];
  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* host hook */ } };
  const post = async (url: string, body: unknown): Promise<unknown> => {
    const init = { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), keepalive: true, signal: AbortSignal.timeout(10_000) };
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`Eye HTTP ${response.status}`);
    return response.json();
  };
  function validChoice(choice: BrowserSnapshot['choices'][number], serverNow: number): boolean {
    return !!choice && typeof choice.experimentId === 'string' && typeof choice.armId === 'string' && typeof choice.receipt === 'string'
      && Number.isFinite(choice.applyUntil) && choice.applyUntil > serverNow
      && (choice.refreshAfter === undefined || Number.isFinite(choice.refreshAfter));
  }
  function install(snapshot: BrowserSnapshot, safetyMs = 0) {
    if (!snapshot || snapshot.scope !== scope || !Number.isFinite(snapshot.serverNow) || !Array.isArray(snapshot.choices)) return;
    const received = performance.now();
    for (const choice of snapshot.choices) {
      if (!validChoice(choice, snapshot.serverNow)) continue;
      if (!states.has(choice.experimentId) && states.size >= 1000) { report(new Error('Eye choice cache full')); continue; }
      if (choice.assignmentId && choice.sample) samples.set(choice.assignmentId, choice.sample);
      while (samples.size > 1000) samples.delete(samples.keys().next().value!);
      // Server returns the sample when preserving an assignment; a different arm/assignment resets it.
      states.set(choice.experimentId, { receipt: choice.receipt, ...(choice.sample === undefined ? {} : { sample: choice.sample }) });
      ready.set(choice.experimentId, { choice, received, receivedWall: Date.now(), serverNow: snapshot.serverNow, safetyMs });
    }
    save();
  }
  function schedulePrepare(delay = 0) {
    if (stopped || preparing || prepareTimer !== undefined || wanted.size === 0) return;
    prepareTimer = setTimeout(() => { prepareTimer = undefined; void prepare(); }, Math.max(delay, nextPrepareAt - performance.now()));
  }
  async function prepare() {
    if (stopped || preparing) return;
    const ids = [...wanted].slice(0, 20), epoch = generation;
    if (!ids.length) return;
    const bodySize = () => new TextEncoder().encode(JSON.stringify({ experimentIds: ids,
      states: Object.fromEntries(ids.flatMap(id => states.has(id) ? [[id, states.get(id)!]] : [])) })).length;
    // Count both receipts and JSON framing. Remaining experiments stay wanted.
    while (ids.length > 1 && bodySize() > 48_000) ids.pop();
    if (bodySize() > 48_000) {
      states.delete(ids[0]!);
      report(new Error('Eye preparation state exceeds the request budget; preparing without it'));
    }
    const started = performance.now();
    const previous = Object.fromEntries(ids.map(id => [id, states.get(id)]));
    const retry = new Set<string>();
    preparing = true; nextPrepareAt = performance.now() + 5000;
    try {
      const requestStates = Object.fromEntries(ids.flatMap(id => previous[id] ? [[id, previous[id]!]] : []));
      const snapshot = options.prepare ? await options.prepare(ids, requestStates) : await post(options.prepareUrl ?? '/eye/prepare', { experimentIds: ids, states: requestStates }) as BrowserSnapshot;
      if (epoch === generation && !stopped) {
        if (!snapshot || snapshot.scope !== scope || !Number.isFinite(snapshot.serverNow) || !Array.isArray(snapshot.choices)
          || !snapshot.choices.every(choice => validChoice(choice, snapshot.serverNow))) {
          throw new Error('Invalid Eye preparation snapshot');
        }
        for (const id of ids) {
          if (states.get(id) !== previous[id]) retry.add(id);
          else ready.delete(id);
        }
        if (snapshot && Array.isArray(snapshot.choices)) snapshot.choices = snapshot.choices.filter(choice => ids.includes(choice.experimentId) && !retry.has(choice.experimentId));
        install(snapshot, Math.max(0, performance.now() - started));
      }
    } catch (error) { report(error); }
    finally {
      preparing = false;
      if (epoch === generation) { for (const id of ids) if (!retry.has(id)) wanted.delete(id); }
      schedulePrepare(1000);
    }
  }
  function scheduleSend(delay = 250) {
    if (stopped || sending || sendTimer !== undefined || !queue.length) return;
    sendTimer = setTimeout(() => { sendTimer = undefined; void flush(); }, delay);
  }
  async function sendBatch(): Promise<void> {
    if (sending || stopped || !queue.length) return;
    sending = true;
    const batch: typeof queue = [];
    let bytes = 2;
    while (queue.length && batch.length < 50) {
      const next = queue[0]!;
      const size = new TextEncoder().encode(JSON.stringify(next.event)).length + 1;
      if (size + 2 > 48_000) { queue.shift(); report(new Error('Eye event exceeds browser batch budget')); continue; }
      if (bytes + size > 48_000) break;
      queue.shift(); batch.push(next); bytes += size;
    }
    try {
      if (!batch.length) return;
      const events = batch.map(item => item.event);
      const results = options.send ? await options.send(events) : await post(options.eventsUrl ?? '/eye/events', events) as BrowserEventResult[];
      if (!Array.isArray(results) || batch.some(item => !results.some(r => r.eventId === item.event.eventId && typeof r.accepted === 'boolean'))) throw new Error('Invalid Eye acknowledgement');
      for (const result of results) if (!result.accepted) report(new Error(`Eye rejected exposure ${result.eventId}`));
    } catch (error) {
      report(error);
      retryAt = performance.now() + 3000;
      if (stopped) return;
      for (const item of batch) {
        item.tries++;
        if (item.tries < 3 && performance.now() - item.queuedAt < 60_000 && queue.length < 100) queue.push(item);
        else report(new Error('Eye dropped exposure after retry limit'));
      }
    } finally { sending = false; }
  }
  function flush(): Promise<void> {
    if (activeFlush) return activeFlush;
    clearTimeout(sendTimer); sendTimer = undefined;
    const drain = async () => {
      while (!stopped && queue.length) {
        const delay = retryAt - performance.now();
        if (delay > 0) await new Promise<void>(resolve => {
          const timer = setTimeout(() => { wakeDrain = undefined; resolve(); }, delay);
          wakeDrain = () => { clearTimeout(timer); wakeDrain = undefined; resolve(); };
        });
        if (!stopped) await sendBatch();
      }
    };
    activeFlush = drain().finally(() => { activeFlush = undefined; scheduleSend(); });
    return activeFlush;
  }
  if (options.initial) install(options.initial);
  return {
    /** Call only after host authentication has changed; old emitted events retain their receipts. */
    setScope(next: string) {
      if (next === scope) return;
      try { storage?.removeItem(storageKey()); } catch { /* optional storage */ }
      scope = next; generation++; ready = new Map(); states = new Map(); samples.clear(); wanted.clear(); nextPrepareAt = 0;
    },
    /** One view per actual navigation/popup lifetime. Retain the view across component re-renders. */
    beginView(): BrowserView {
      const epoch = generation;
      let disposed = false;
      const selections = new Map<string, BrowserSelection<unknown>>();
      return {
        variant<T>(definition: VariantDefinition<T>, placement = 'default'): BrowserSelection<T> {
          const key = JSON.stringify([definition.experimentId, placement]);
          const old = selections.get(key);
          if (old && !stopped && !disposed && epoch === generation) return old as BrowserSelection<T>;
          const fallback: BrowserSelection<T> = { value: definition.fallback, armId: null, expose: () => false };
          let selection = fallback;
          if (!stopped && !disposed && epoch === generation) {
            const cached = ready.get(definition.experimentId);
            const now = cached ? cached.serverNow + Math.max(0, performance.now() - cached.received, Date.now() - cached.receivedWall) : Infinity;
            if (!cached || now + cached.safetyMs >= cached.choice.applyUntil) {
              wanted.add(definition.experimentId); schedulePrepare();
            } else if (Object.hasOwn(definition.variants, cached.choice.armId)) {
              let emitted = false;
              selection = { value: definition.variants[cached.choice.armId]!, armId: cached.choice.armId,
                expose() {
                  if (emitted) return true;
                  const at = Math.floor(cached.serverNow + Math.max(0, performance.now() - cached.received, Date.now() - cached.receivedWall));
                  if (stopped || disposed || epoch !== generation || at + cached.safetyMs >= cached.choice.applyUntil) return false;
                  if (queue.length >= 100) { report(new Error('Eye exposure queue full')); return false; }
                  const eventId = crypto.randomUUID();
                  let sample = (cached.choice.assignmentId ? samples.get(cached.choice.assignmentId) : undefined) ?? cached.choice.sample;
                  if (cached.choice.assignmentId && cached.choice.observationWindowMs) {
                    if (!sample || at >= sample.startAt + cached.choice.observationWindowMs) sample = { sampleId: crypto.randomUUID(), startAt: at };
                    // Preserve the newest receipt when an older view exposes the same assignment.
                    const current = ready.get(definition.experimentId);
                    if (current?.choice.assignmentId === cached.choice.assignmentId) {
                      current.choice.sample = sample;
                      states.set(definition.experimentId, { receipt: current.choice.receipt, sample }); save();
                    }
                    samples.set(cached.choice.assignmentId, sample);
                    while (samples.size > 1000) samples.delete(samples.keys().next().value!);
                    cached.choice.sample = sample;
                  }
                  queue.push({ event: { eventId, receipt: cached.choice.receipt, occurredAt: at, ...(sample === undefined ? {} : { sample }) }, tries: 0, queuedAt: performance.now() });
                  emitted = true; scheduleSend(); return true;
                } };
              if (now + cached.safetyMs >= (cached.choice.refreshAfter ?? cached.serverNow + DEFAULT_POLICY_FRESH_MS) || cached.choice.applyUntil - now < 60_000) { wanted.add(definition.experimentId); schedulePrepare(); }
            } else report(new Error(`Unsupported Eye arm: ${cached.choice.armId}`));
          }
          selections.set(key, selection); return selection;
        },
        dispose() { disposed = true; selections.clear(); },
      };
    },
    /** Best effort on visibilitychange; async fetch acknowledgement supports bounded retry. No unload-only dependency. */
    flush,
    /** Stops timers and future selection. Call flush first if delivery is desired. */
    dispose() { stopped = true; generation++; clearTimeout(prepareTimer); clearTimeout(sendTimer); wakeDrain?.(); ready.clear(); wanted.clear(); queue.length = 0; },
  };
}
