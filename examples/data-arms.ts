import { createEye, createEyeRequest, type EyeOptions, type JsonValue } from '@eye/workers';
import { createEyeBrowser, type BrowserSnapshot } from '@eye/workers/browser';
const baseline = { headline: 'Write your paper', ctaLabel: 'Start' };
function parseCopy(data: JsonValue): typeof baseline {
  if (!data || typeof data !== 'object' || !('headline' in data) || !('ctaLabel' in data)
    || typeof data.headline !== 'string' || typeof data.ctaLabel !== 'string') throw new Error('Invalid landing copy');
  return { headline: data.headline, ctaLabel: data.ctaLabel };
}
const definition = { experimentId: 'landing-copy', defaultArm: 'control', defaultValue: baseline, parse: parseCopy };
/** Trusted management boundary; subsequent data arms use the same deployed renderer. */
export async function register(options: EyeOptions) {
  const eye = createEye(options);
  await eye.experiments.create({ experimentId: 'landing-copy', arms: ['control'], settings: { minHoldMs: 0 } });
  await eye.experiments.addArm('landing-copy', { armId: 'copy-b', data: { headline: 'Write together', ctaLabel: 'Try' } });
}
export function browser(initial: BrowserSnapshot, commit: (copy: typeof baseline, afterCommit: () => void) => void) {
  const eye = createEyeBrowser({ scope: initial.scope, initial });
  const selected = eye.beginView().data(definition);
  commit(selected.value, () => { selected.expose(); });
  return eye;
}
export async function server(options: EyeOptions, cid: string) {
  const eye = createEyeRequest({ ...options, subject: { cid } });
  return eye.data(definition, { maxWaitMs: 0 });
}
