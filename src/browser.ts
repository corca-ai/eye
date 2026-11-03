import { selectionFallback, selectionValue, isDataDefinition, withinBudget, type SelectionDefinition } from './variant-definition.js';
import { EVENT_MAX_AGE_MS } from './core/validation.js';
import { DEFAULT_POLICY_FRESH_MS } from './policy-timing.js';
import type { VariantDefinition, DataDefinition } from './browser-types.js';
import type { BrowserSnapshot, BrowserExposure, BrowserEventResult, BrowserState } from './browser-types.js';
export type { BrowserSnapshot, BrowserExposure, BrowserEventResult, BrowserState } from './browser-types.js';
/** 브라우저 전용 설정. 서버 secret·Worker 바인딩은 받지 않는다. */
export interface BrowserOptions {
  /** 서버 snapshot과 일치하는 비밀이 아닌 인증 세대. 로그인·로그아웃·계정 변경마다 바꾼다. */
  scope: string;
  /** 같은 scope의 최신 서버 응답. 없으면 첫 뷰는 fallback을 쓰며 준비를 시작한다. */
  initial?: BrowserSnapshot;
  /** Elapsed milliseconds since initial.serverNow was captured, including bootstrap/HTML transit. */
  initialAgeMs?: number;
  /** 준비 POST 경로. 기본 /eye/prepare; 기본 전송은 same-origin 쿠키 인증을 사용한다. */
  prepareUrl?: string;
  /** 노출 POST 경로. 기본 /eye/events. */
  eventsUrl?: string;
  /** 기본 sessionStorage. 증표·표본 문맥만 저장하며 미전송 이벤트는 저장하지 않는다. */
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
  /** 준비·전송 실패와 노출 거절·유실을 알린다. 콜백에서 던진 오류는 무시한다. */
  onError?: (error: unknown) => void;
  /** 기본 HTTP 준비를 대체한다. 같은 scope의 snapshot을 반환하고 인증·timeout은 호스트가 처리한다. */
  prepare?: (experiments: string[], states: Readonly<Record<string, BrowserState>>, defaultStates: Readonly<Record<string, BrowserState>>) => Promise<BrowserSnapshot>;
  /** 기본 HTTP 전송을 대체한다. 각 eventId의 결과를 반환하며 전송 실패 시 reject해 재시도를 유도한다. 인증·timeout은 호스트 책임이다. */
  send?: (events: BrowserExposure[]) => Promise<BrowserEventResult[]>;
}
/** 한 뷰·실험·placement에서 고정된 선택. 준비가 끝나도 현재 value는 바뀌지 않는다. */
export interface BrowserSelection<T> {
  readonly value: T;
  readonly armId: string | null;
  /** 실제 표시 후 호출한다. true는 최초 로컬 접수 또는 이미 접수한 핸들이며 전달 성공은 아니다. 미접수 fallback·만료·폐기 핸들은 false. */
  expose(): boolean;
  /** Replace only before actual application; never executes or retries the value. */
  useDefault(reason: import('./core/types.js').DefaultReason): BrowserSelection<T>;
}
/** 실제 라우트·팝업 수명에 맞춘 선택 묶음. 컴포넌트 재렌더 동안 같은 뷰를 유지한다. */
export interface BrowserView {
  /** 동기 선택. experimentId·placement별 첫 값을 고정하며 미준비면 fallback과 백그라운드 준비를 사용한다. placement 기본 default. */
  variant<T>(definition: VariantDefinition<T>, placement?: string): BrowserSelection<T>;
  /** 이 뷰의 추가 노출을 막는다. 이미 접수한 이벤트는 취소하지 않는다. */
  /** Explicitly allow bounded preparation before this occurrence freezes. */
  variantAsync<T>(definition: VariantDefinition<T>, options: { maxWaitMs: number }, placement?: string): Promise<BrowserSelection<T>>;
  /** Select data using the host default/parser and the same fixed occurrence as variant. */
  data<T>(definition: DataDefinition<T>, placement?: string): BrowserSelection<T>;
  /** Bound policy preparation, then freeze selected data or the host default. */
  dataAsync<T>(definition: DataDefinition<T>, options: { maxWaitMs: number }, placement?: string): Promise<BrowserSelection<T>>;
  dispose(): void;
}
/** 브라우저 앱 수명 동안 재사용한다. 로그인 전환에는 setScope, 화면 전환에는 beginView를 사용한다. */
export interface EyeBrowser {
  /** Explicit preparation shares transport work, preserves state and never applies a variant. */
  prepare(experimentIds: readonly string[]): Promise<Record<string, 'assigned' | 'inactive' | 'unavailable'>>;
  /** 인증 변경 완료 후 호출한다. 이전 선택·저장 문맥을 비우고 새 뷰를 요구하며 이미 접수한 이벤트의 신원은 유지한다. */
  setScope(scope: string): void;
  /** 새 화면 수명에 대한 뷰를 만든다. 이 호출 자체가 서버 준비나 노출을 발생시키지는 않는다. */
  beginView(): BrowserView;
  /** 진행 중 전송과 큐를 제한된 재시도까지 처리한다. 실패는 onError로 보고하므로 resolve가 전체 전달 성공을 뜻하지 않는다. */
  flush(): Promise<void>;
  /** 타이머·향후 선택을 중단하고 미전송 큐를 비운다. 전송이 필요하면 먼저 flush한다. 진행 중 HTTP는 취소하지 않는다. */
  dispose(): void;
}
/** 브라우저 전용의 프레임워크 독립 클라이언트. 선택은 동기이며 실제 표시 시 expose를 호출한다. */
export function createEyeBrowser(options: BrowserOptions): EyeBrowser {
  let scope = options.scope, generation = 0, stopped = false;
  let ready = new Map<string, { choice: BrowserSnapshot['choices'][number]; received: number; receivedWall: number; serverNow: number; safetyMs: number }>();
  let defaults = new Map<string, { choice: BrowserSnapshot['choices'][number]; received: number; receivedWall: number; serverNow: number; safetyMs: number }>();
  let states = new Map<string, BrowserState>();
  type StoredDefault = BrowserState & { choice?: BrowserSnapshot['choices'][number]; serverNow?: number; receivedWall?: number; safetyMs?: number };
  let defaultStates = new Map<string, StoredDefault>();
  const statuses = new Map<string, 'assigned' | 'inactive' | 'unavailable'>();
  let storage = options.storage;
  try { storage ??= (globalThis as unknown as { sessionStorage?: BrowserOptions['storage'] }).sessionStorage; } catch { /* Storage can be disabled by browser policy. */ }
  const samples = new Map<string, NonNullable<BrowserState['sample']>>();
  const wireState = (state: BrowserState): BrowserState => ({ receipt: state.receipt, ...(state.sample === undefined ? {} : { sample: state.sample }) });
  const storageKey = () => `eye/browser/v2/${scope}`;
  const save = () => { try { storage?.setItem(storageKey(), JSON.stringify(Object.fromEntries(states))); storage?.setItem(storageKey() + '/defaults', JSON.stringify(Object.fromEntries(defaultStates))); } catch (error) { report(error); } };
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
  try {
    const saved = storage?.getItem(storageKey() + '/defaults');
    if (saved && saved.length <= 2_000_000) {
      const raw: unknown = JSON.parse(saved);
      if (raw && typeof raw === 'object' && !Array.isArray(raw))
        for (const [id, value] of Object.entries(raw).slice(0, 1000))
          if (value && typeof value === 'object' && 'receipt' in value && typeof value.receipt === 'string') defaultStates.set(id, value as StoredDefault);
    }
  } catch { /* Optional storage. */ }
  const wanted = new Set<string>();
  let nextPrepareAt = 0;
  let preparing = false, prepareTimer: ReturnType<typeof setTimeout> | undefined;
  let sendTimer: ReturnType<typeof setTimeout> | undefined, sending = false;
  let activeFlush: Promise<void> | undefined;
  let retryAt = 0;
  let wakeDrain: (() => void) | undefined;
  const queue: { event: BrowserExposure; tries: number; queuedAt: number; queuedWall: number }[] = [];
  const queuedAge = (item: (typeof queue)[number]) => Math.max(performance.now() - item.queuedAt, Date.now() - item.queuedWall);
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
  function install(snapshot: BrowserSnapshot, safetyMs = 0, restoreStored = false) {
    if (!snapshot || snapshot.scope !== scope || !Number.isFinite(snapshot.serverNow) || !Array.isArray(snapshot.choices)) return;
    const received = performance.now();
    for (const supplied of [...snapshot.choices, ...(snapshot.defaults ?? []).map(c => ({ ...c, allocation: 'default' as const }))]) {
      if (!validChoice(supplied, snapshot.serverNow)) continue;
      // Exposure updates belong to this client, not the host's snapshot/cache.
      let choice = { ...supplied };
      let serverNow = snapshot.serverNow, margin = safetyMs;
      if (restoreStored && choice.allocation === 'default') {
        const saved = defaultStates.get(choice.experimentId);
        const prior = saved?.choice;
        const sameAssignment = prior?.assignmentId && prior.assignmentId === choice.assignmentId;
        const sameSemantics = prior?.contextKey && prior.contextKey === choice.contextKey;
        if (saved?.sample && (sameAssignment || sameSemantics)) {
          if (sameAssignment) choice.sample = saved.sample;
          else if (prior && Number.isFinite(saved.serverNow) && Number.isFinite(saved.receivedWall)) {
            serverNow = Math.max(serverNow, saved.serverNow! + Math.max(0, Date.now() - saved.receivedWall!));
            margin = Math.max(margin, saved.safetyMs ?? 0);
            const sampleEnd = saved.sample.startAt + (prior.observationWindowMs ?? 0);
            if (serverNow < sampleEnd) {
              wanted.add(choice.experimentId); schedulePrepare();
              // A fresh navigation cannot rewrite a signed old assignment. Use
              // its still-valid capability while preparation renews that context.
              if (serverNow + margin >= prior.applyUntil) continue;
              choice = { ...prior, sample: saved.sample, refreshAfter: serverNow };
            }
          }
        }
      }
      const targetStates = choice.allocation === 'default' ? defaultStates : states;
      const targetReady = choice.allocation === 'default' ? defaults : ready;
      if (!targetStates.has(choice.experimentId) && targetStates.size >= 1000) { report(new Error('Eye choice cache full')); continue; }
      if (choice.assignmentId && choice.sample) samples.set(choice.assignmentId, choice.sample);
      while (samples.size > 1000) samples.delete(samples.keys().next().value!);
      // Server returns the sample when preserving an assignment; a different arm/assignment resets it.
      const receivedWall = Date.now();
      const state = { receipt: choice.receipt, ...(choice.sample === undefined ? {} : { sample: choice.sample }) };
      if (choice.allocation === 'default') defaultStates.set(choice.experimentId, { ...state, choice, serverNow, receivedWall, safetyMs: margin });
      else states.set(choice.experimentId, state);
      targetReady.set(choice.experimentId, { choice, received, receivedWall, serverNow, safetyMs: margin });
    }
    for (const [id, status] of Object.entries(snapshot.statuses ?? {})) {
      statuses.set(id, status);
      if (status === 'inactive') { ready.delete(id); defaults.delete(id); }
    }
    save();
  }
  function schedulePrepare(delay = 0) {
    if (stopped || preparing || prepareTimer !== undefined || wanted.size === 0) return;
    prepareTimer = setTimeout(() => { prepareTimer = undefined; void prepare(); }, Math.max(delay, nextPrepareAt - performance.now()));
  }
  let preparation: Promise<void> | undefined;
  function prepare(): Promise<void> {
    if (preparation) return preparation;
    preparation = runPrepare().finally(() => { preparation = undefined; });
    return preparation;
  }
  async function runPrepare() {
    if (stopped || preparing) return;
    const ids = [...wanted].slice(0, 20), epoch = generation;
    if (!ids.length) return;
    const bodySize = () => new TextEncoder().encode(JSON.stringify({ experimentIds: ids,
      states: Object.fromEntries(ids.flatMap(id => states.has(id) ? [[id, states.get(id)!]] : [])),
      defaultStates: Object.fromEntries(ids.flatMap(id => defaultStates.has(id) ? [[id, wireState(defaultStates.get(id)!)]] : [])) })).length;
    // Count both receipts and JSON framing. Remaining experiments stay wanted.
    while (ids.length > 1 && bodySize() > 48_000) ids.pop();
    if (bodySize() > 48_000) {
      states.delete(ids[0]!); defaultStates.delete(ids[0]!);
      report(new Error('Eye preparation state exceeds the request budget; preparing without it'));
    }
    const started = performance.now();
    const previous = Object.fromEntries(ids.map(id => [id, states.get(id)]));
    const priorDefaults = Object.fromEntries(ids.map(id => [id, defaultStates.get(id)]));
    const retry = new Set<string>();
    preparing = true; nextPrepareAt = performance.now() + 5000;
    try {
      const requestStates = Object.fromEntries(ids.flatMap(id => previous[id] ? [[id, previous[id]!]] : []));
      const snapshot = options.prepare ? await options.prepare(ids, requestStates, Object.fromEntries(ids.flatMap(id => priorDefaults[id] ? [[id, wireState(priorDefaults[id]!)]] : []))) : await post(options.prepareUrl ?? '/eye/prepare', { experimentIds: ids, states: requestStates, defaultStates: Object.fromEntries(ids.flatMap(id => priorDefaults[id] ? [[id, wireState(priorDefaults[id]!)]] : [])) }) as BrowserSnapshot;
      if (epoch === generation && !stopped) {
        if (!snapshot || snapshot.scope !== scope || !Number.isFinite(snapshot.serverNow) || !Array.isArray(snapshot.choices)
          || !snapshot.choices.every(choice => validChoice(choice, snapshot.serverNow))
          || (snapshot.defaults !== undefined && (!Array.isArray(snapshot.defaults) || !snapshot.defaults.every(choice => validChoice(choice, snapshot.serverNow))))) {
          throw new Error('Invalid Eye preparation snapshot');
        }
        for (const id of ids) {
          if (states.get(id) !== previous[id]) retry.add(id);
          else ready.delete(id);
          if (defaultStates.get(id) !== priorDefaults[id]) retry.add(id);
          else defaults.delete(id);
        }
        install({ ...snapshot, choices: snapshot.choices.filter(choice => ids.includes(choice.experimentId) && !retry.has(choice.experimentId)),
          defaults: (snapshot.defaults ?? []).filter(choice => ids.includes(choice.experimentId) && !retry.has(choice.experimentId)) },
          Math.max(0, performance.now() - started));
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
      if (queuedAge(next) > EVENT_MAX_AGE_MS) {
        queue.shift(); report(new Error('Eye dropped expired exposure')); continue;
      }
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
        if (item.tries < 3 && queuedAge(item) + 3000 <= EVENT_MAX_AGE_MS && queue.length < 100) queue.push(item);
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
  if (options.initialAgeMs !== undefined && (!Number.isFinite(options.initialAgeMs) || options.initialAgeMs < 0)) throw new Error('Invalid initial snapshot age');
  if (options.initial) {
    const age = options.initialAgeMs ?? Math.max(0, Date.now() - options.initial.serverNow);
    install({ ...options.initial, serverNow: options.initial.serverNow + age }, 0, true);
  }
  async function prepareExperiments(experimentIds: readonly string[]) {
    if (stopped) throw new Error('Eye browser disposed');
    if (!Array.isArray(experimentIds) || experimentIds.length > 20 || experimentIds.some(id => typeof id !== 'string' || !id)) throw new Error('At most 20 experiment IDs required');
    const epoch = generation;
    for (const id of experimentIds) wanted.add(id);
    clearTimeout(prepareTimer); prepareTimer = undefined;
    // Explicit preparation can join existing work. Anything not included in that
    // request is prepared next; a failed ID is not retried in a tight loop.
    if (preparation) await preparation;
    if (epoch !== generation || stopped) return {};
    while (experimentIds.some(id => wanted.has(id))) {
      const delay = nextPrepareAt - performance.now();
      if (delay > 0) await new Promise<void>(resolve => { setTimeout(resolve, delay); });
      if (epoch !== generation || stopped) return {};
      await prepare();
    }
    if (epoch !== generation || stopped) return {};
    return Object.fromEntries(experimentIds.map(id => [id, ready.has(id) ? 'assigned' : statuses.get(id) ?? 'unavailable'])) as Record<string, 'assigned' | 'inactive' | 'unavailable'>;
  }
  return {
    prepare: prepareExperiments,
    setScope(next: string) {
      if (next === scope) return;
      try { storage?.removeItem(storageKey()); storage?.removeItem(storageKey() + '/defaults'); } catch { /* optional storage */ }
      scope = next; generation++; ready = new Map(); defaults = new Map(); states = new Map(); defaultStates = new Map(); statuses.clear(); samples.clear(); wanted.clear(); nextPrepareAt = 0;
    },
    beginView(): BrowserView {
      const epoch = generation;
      let disposed = false;
      const selections = new Map<string, BrowserSelection<unknown>>();
      const owners = new Map<string, symbol>();
      const live = () => !stopped && !disposed && epoch === generation;
      function currentTime(cached: NonNullable<ReturnType<typeof ready.get>>) {
        return cached.serverNow + Math.max(0, performance.now() - cached.received, Date.now() - cached.receivedWall);
      }
      function usable(cached: ReturnType<typeof ready.get>): cached is NonNullable<typeof cached> {
        return !!cached && currentTime(cached) + cached.safetyMs < cached.choice.applyUntil;
      }
      function variant<T>(definition: SelectionDefinition<T>, placement = 'default', defaultReason: import('./core/types.js').DefaultReason = 'unprepared'): BrowserSelection<T> {
        const key = JSON.stringify([definition.experimentId, placement]);
        const old = selections.get(key);
        if (old && live()) return old as BrowserSelection<T>;
        const fallback = selectionFallback(definition);
        const owner = Symbol(); owners.set(key, owner);
        let emitted = false;
        let replacement: BrowserSelection<T> | undefined;
        function make(cached?: NonNullable<ReturnType<typeof ready.get>>, reason?: import('./core/types.js').DefaultReason, resolved?: { value: T }): BrowserSelection<T> {
          const myOwner = owners.get(key);
          let accepted = false;
          return { value: resolved === undefined ? fallback : resolved.value, armId: cached?.choice.armId ?? null,
            useDefault(defaultReason) {
              if (emitted) throw new Error('An applied occurrence cannot switch arms');
              if (replacement) return replacement;
              owners.set(key, Symbol());
              const next = defaults.get(definition.experimentId);
              replacement = make(cached && live() && usable(next) && next.choice.armId === definition.defaultArm ? next : undefined, defaultReason);
              selections.set(key, replacement);
              return replacement;
            },
            expose() {
              if (accepted) return true;
              if (!live() || owners.get(key) !== myOwner || emitted) return false;
              emitted = true; // Actual application is independent of telemetry admission.
              if (!cached || !usable(cached)) return false;
              if (queue.length >= 100) { report(new Error('Eye exposure queue full')); return false; }
              const at = Math.floor(currentTime(cached));
              const eventId = crypto.randomUUID();
              let sample = (cached.choice.assignmentId ? samples.get(cached.choice.assignmentId) : undefined) ?? cached.choice.sample;
              if (cached.choice.assignmentId && cached.choice.observationWindowMs) {
                if (!sample || at >= sample.startAt + cached.choice.observationWindowMs) sample = { sampleId: crypto.randomUUID(), startAt: at };
                const target = cached.choice.allocation === 'default' ? defaults : ready;
                const targetStates = cached.choice.allocation === 'default' ? defaultStates : states;
                const current = target.get(definition.experimentId);
                if (current?.choice.assignmentId === cached.choice.assignmentId) {
                  current.choice.sample = sample;
                  if (cached.choice.allocation === 'default') defaultStates.set(definition.experimentId,
                    { receipt: current.choice.receipt, sample, choice: current.choice, serverNow: current.serverNow,
                      receivedWall: current.receivedWall, safetyMs: current.safetyMs });
                  else targetStates.set(definition.experimentId, { receipt: current.choice.receipt, sample });
                  save();
                }
                samples.set(cached.choice.assignmentId, sample);
                while (samples.size > 1000) samples.delete(samples.keys().next().value!);
                cached.choice.sample = sample;
              }
              queue.push({ event: { eventId, receipt: cached.choice.receipt, occurredAt: at,
                ...(sample === undefined ? {} : { sample }), ...(reason === undefined ? {} : { defaultReason: reason }) },
                tries: 0, queuedAt: performance.now(), queuedWall: Date.now() });
              emitted = true; accepted = true; scheduleSend(); return true;
            } };
        }
        let cached = ready.get(definition.experimentId);
        const value = usable(cached) ? selectionValue(definition, cached.choice.armId, cached.choice.data) : undefined;
        const unsupported = value?.supported === false;
        let reason: import('./core/types.js').DefaultReason | undefined;
        if (unsupported) {
          report(new Error(`Unsupported Eye arm or invalid data: ${cached!.choice.armId}`)); cached = undefined;
          if (isDataDefinition(definition)) reason = 'invalid_data';
        }
        if (!usable(cached)) {
          wanted.add(definition.experimentId); schedulePrepare();
          const defaultChoice = defaults.get(definition.experimentId);
          cached = (!unsupported || isDataDefinition(definition)) && usable(defaultChoice) && defaultChoice.choice.armId === definition.defaultArm ? defaultChoice : undefined;
          if (cached) reason ??= defaultReason;
        }
        if (cached && (currentTime(cached) + cached.safetyMs >= (cached.choice.refreshAfter ?? cached.serverNow + DEFAULT_POLICY_FRESH_MS)
          || cached.choice.applyUntil - currentTime(cached) < 60_000)) { wanted.add(definition.experimentId); schedulePrepare(); }
        const selected = make(live() ? cached : undefined, reason, live() && cached && !unsupported && value?.supported ? value : undefined);
        selections.set(key, selected); return selected;
      }
      async function variantAsync<T>(definition: SelectionDefinition<T>, wait: { maxWaitMs: number }, placement = 'default') {
        if (!Number.isSafeInteger(wait.maxWaitMs) || wait.maxWaitMs < 0) throw new Error('Invalid wait budget');
        const key = JSON.stringify([definition.experimentId, placement]);
        let timedOut = false;
        if (!selections.has(key) && live() && !usable(ready.get(definition.experimentId)) && wait.maxWaitMs > 0)
          timedOut = (await withinBudget(prepareExperiments([definition.experimentId]), wait.maxWaitMs)) === undefined;
        return variant(definition, placement, timedOut ? 'deadline' : 'unprepared');
      }
      return { variant, variantAsync, data: variant, dataAsync: variantAsync,
        dispose() { disposed = true; selections.clear(); owners.clear(); },
      };
    },
    flush,
    dispose() { stopped = true; generation++; clearTimeout(prepareTimer); clearTimeout(sendTimer); wakeDrain?.(); ready.clear(); defaults.clear(); wanted.clear(); queue.length = 0; },
  };
}

export type { DataDefinition } from './browser-types.js';
export type { JsonValue } from './core/types.js';
