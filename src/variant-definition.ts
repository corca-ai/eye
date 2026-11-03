import type { VariantDefinition } from './browser-types.js';
/** Resolve only an inert value. Never execute a component, loader or business action. */
export function fallbackValue<T>(definition: VariantDefinition<T>): T {
  if (definition.defaultArm !== undefined) {
    if (!Object.hasOwn(definition.variants, definition.defaultArm)) throw new Error('Default arm must have an implementation');
    return definition.variants[definition.defaultArm]!;
  }
  return definition.fallback;
}
/** A timeout is not RPC cancellation. Late work may warm later selections only. */
export async function withinBudget<T>(work: Promise<T>, maxWaitMs: number): Promise<T | undefined> {
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0) throw new Error('maxWaitMs must be a nonnegative integer');
  if (maxWaitMs === 0) { void work.catch(() => {}); return undefined; }
  let cancel = () => {};
  try { return await Promise.race([work, new Promise<undefined>(resolve => { const timer = setTimeout(resolve, maxWaitMs); cancel = () => clearTimeout(timer); })]); }
  finally { cancel(); }
}
