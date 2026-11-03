import { createEyeRequest, type EyeOptions } from '@eye/workers';
import { createEyeBrowser, type BrowserSnapshot } from '@eye/workers/browser';

/** Whole-page selection uses inert render functions; the host owns the actual commit. */
export function wholePage(initial: BrowserSnapshot, mount: (render: () => string) => void) {
  const eye = createEyeBrowser({ scope: initial.scope, initial });
  const selected = eye.beginView().variant({ experimentId: 'landing', defaultArm: 'control',
    variants: { control: (): string => 'Control page', alternative: (): string => 'Alternative page' } });
  mount(selected.value); selected.expose();
  return eye;
}
/** Load only the requested fragment; abandon a failed loader before applying anything. */
export async function lazyFragment(initial: BrowserSnapshot, loaders: Record<'control' | 'alternative', () => Promise<string>>, mount: (content: string) => void) {
  const eye = createEyeBrowser({ scope: initial.scope, initial });
  const view = eye.beginView();
  let selected = await view.variantAsync({ experimentId: 'fragment', defaultArm: 'control', variants: loaders }, { maxWaitMs: 50 });
  let content: string;
  try { content = await selected.value(); }
  catch { selected = selected.useDefault('resource_unready'); content = await selected.value(); }
  mount(content); selected.expose();
  return eye;
}
/** A preloaded client algorithm starts immediately; ingestion is never awaited. */
export function clientAction(initial: BrowserSnapshot, algorithms: Record<'control' | 'alternative', (n: number) => number>, input: number) {
  const eye = createEyeBrowser({ scope: initial.scope, initial });
  const selected = eye.beginView().variant({ experimentId: 'algorithm', defaultArm: 'control', variants: algorithms });
  selected.expose(); // Invocation boundary, not proof of a successful business outcome.
  const result = selected.value(input);
  return { result, eye };
}
/** An authenticated server API enters exactly one handler; failed effects are never retried through default. */
export async function serverApi(options: EyeOptions, cid: string, handlers: Record<'control' | 'alternative', () => Promise<Response>>) {
  const eye = createEyeRequest({ ...options, subject: { cid } });
  const selected = await eye.variant({ experimentId: 'api', defaultArm: 'control', variants: handlers }, { maxWaitMs: 0 });
  selected.expose();
  return selected.value();
}
