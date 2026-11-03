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

import { armData } from './core/arm-data.js';
import type { DataDefinition } from './browser-types.js';
import type { JsonValue } from './core/types.js';
export type SelectionDefinition<T> = VariantDefinition<T> | DataDefinition<T>;
export function isDataDefinition<T>(definition: SelectionDefinition<T>): definition is DataDefinition<T> {
  return 'defaultValue' in definition;
}
export function selectionFallback<T>(definition: SelectionDefinition<T>): T {
  return isDataDefinition(definition) ? definition.defaultValue : fallbackValue(definition);
}
/** The host parser sees a bounded copy, so it cannot mutate the cached policy/choice. */
export function selectionValue<T>(definition: SelectionDefinition<T>, armId: string, data: JsonValue | undefined): { supported: true; value: T } | { supported: false } {
  if (!isDataDefinition(definition)) return Object.hasOwn(definition.variants, armId)
    ? { supported: true, value: definition.variants[armId]! } : { supported: false };
  if (armId === definition.defaultArm) return { supported: true, value: definition.defaultValue };
  if (data === undefined) return { supported: false };
  try { return { supported: true, value: definition.parse(armData(data)) }; }
  catch { return { supported: false }; }
}
