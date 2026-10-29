import { EVENT_MAX_AGE_MS } from './core/validation.js';
import { DEFAULT_POLICY_FRESH_MS } from './policy-timing.js';
import type { VariantDefinition } from './browser-types.js';
import type { BrowserSnapshot, BrowserExposure, BrowserEventResult, BrowserState } from './browser-types.js';
export type { BrowserSnapshot, BrowserExposure, BrowserEventResult, BrowserState } from './browser-types.js';
/** 브라우저 전용 설정. 서버 secret·Worker 바인딩은 받지 않는다. */
export interface BrowserOptions {
  /** 서버 snapshot과 일치하는 비밀이 아닌 인증 세대. 로그인·로그아웃·계정 변경마다 바꾼다. */
  scope: string;
  /** 같은 scope의 최신 서버 응답. 없으면 첫 뷰는 fallback을 쓰며 준비를 시작한다. */
  initial?: BrowserSnapshot;
  /** 준비 POST 경로. 기본 /eye/prepare; 기본 전송은 same-origin 쿠키 인증을 사용한다. */
  prepareUrl?: string;
  /** 노출 POST 경로. 기본 /eye/events. */
  eventsUrl?: string;
  /** 기본 sessionStorage. 증표·표본 문맥만 저장하며 미전송 이벤트는 저장하지 않는다. */
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
  /** 준비·전송 실패와 노출 거절·유실을 알린다. 콜백에서 던진 오류는 무시한다. */
  onError?: (error: unknown) => void;
  /** 기본 HTTP 준비를 대체한다. 같은 scope의 snapshot을 반환하고 인증·timeout은 호스트가 처리한다. */
  prepare?: (experiments: string[], states: Readonly<Record<string, BrowserState>>) => Promise<BrowserSnapshot>;
  /** 기본 HTTP 전송을 대체한다. 각 eventId의 결과를 반환하며 전송 실패 시 reject해 재시도를 유도한다. 인증·timeout은 호스트 책임이다. */
  send?: (events: BrowserExposure[]) => Promise<BrowserEventResult[]>;
}
/** 한 뷰·실험·placement에서 고정된 선택. 준비가 끝나도 현재 value는 바뀌지 않는다. */
export interface BrowserSelection<T> {
  readonly value: T;
  readonly armId: string | null;
  /** 실제 표시 후 호출한다. true는 최초 로컬 접수 또는 이미 접수한 핸들이며 전달 성공은 아니다. 미접수 fallback·만료·폐기 핸들은 false. */
  expose(): boolean;
}
/** 실제 라우트·팝업 수명에 맞춘 선택 묶음. 컴포넌트 재렌더 동안 같은 뷰를 유지한다. */
export interface BrowserView {
  /** 동기 선택. experimentId·placement별 첫 값을 고정하며 미준비면 fallback과 백그라운드 준비를 사용한다. placement 기본 default. */
  variant<T>(definition: VariantDefinition<T>, placement?: string): BrowserSelection<T>;
  /** 이 뷰의 추가 노출을 막는다. 이미 접수한 이벤트는 취소하지 않는다. */
  dispose(): void;
}
/** 브라우저 앱 수명 동안 재사용한다. 로그인 전환에는 setScope, 화면 전환에는 beginView를 사용한다. */
export interface EyeBrowser {
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
  function install(snapshot: BrowserSnapshot, safetyMs = 0) {
    if (!snapshot || snapshot.scope !== scope || !Number.isFinite(snapshot.serverNow) || !Array.isArray(snapshot.choices)) return;
    const received = performance.now();
    for (const supplied of snapshot.choices) {
      if (!validChoice(supplied, snapshot.serverNow)) continue;
      // Exposure updates belong to this client, not the host's snapshot/cache.
      const choice = { ...supplied };
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
        install({ ...snapshot, choices: snapshot.choices.filter(choice => ids.includes(choice.experimentId) && !retry.has(choice.experimentId)) },
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
  if (options.initial) install(options.initial);
  return {
    setScope(next: string) {
      if (next === scope) return;
      try { storage?.removeItem(storageKey()); } catch { /* optional storage */ }
      scope = next; generation++; ready = new Map(); states = new Map(); samples.clear(); wanted.clear(); nextPrepareAt = 0;
    },
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
                  queue.push({ event: { eventId, receipt: cached.choice.receipt, occurredAt: at, ...(sample === undefined ? {} : { sample }) }, tries: 0, queuedAt: performance.now(), queuedWall: Date.now() });
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
    flush,
    dispose() { stopped = true; generation++; clearTimeout(prepareTimer); clearTimeout(sendTimer); wakeDrain?.(); ready.clear(); wanted.clear(); queue.length = 0; },
  };
}
