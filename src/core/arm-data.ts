import { invariant } from './errors.js';
import { id, record } from './validation.js';
import type { ArmDefinition, ArmInput, JsonValue } from './types.js';

export const MAX_ARM_DATA_BYTES = 16 * 1024;
export const MAX_EXPERIMENT_DATA_BYTES = 64 * 1024;
/** Copy bounded JSON without coercion, custom serializers, accessors or shared mutable references. */
export function armData(value: unknown): JsonValue {
  let nodes = 0, textUnits = 0;
  const accountText = (text: string) => {
    textUnits += text.length;
    invariant(textUnits <= MAX_ARM_DATA_BYTES, 'invalid_input', 'Arm data text is too large');
  };
  const ancestors = new Set<object>();
  function visit(input: unknown, depth: number): JsonValue {
    invariant(++nodes <= 4096 && depth <= 16, 'invalid_input', 'Arm data is too complex');
    if (typeof input === 'string') { accountText(input); return input; }
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') { invariant(Number.isFinite(input), 'invalid_input', 'Arm data numbers must be finite'); return input; }
    invariant(typeof input === 'object' && input !== null && !ancestors.has(input), 'invalid_input', 'Arm data must be acyclic JSON');
    ancestors.add(input);
    const read = (key: string) => {
      const property = Object.getOwnPropertyDescriptor(input, key);
      invariant(property && 'value' in property, 'invalid_input', 'Arm data must not contain accessors or array holes');
      return visit(property.value, depth + 1);
    };
    let result: JsonValue;
    if (Array.isArray(input)) {
      invariant(input.length <= 4096, 'invalid_input', 'Arm data array is too large');
      result = Array.from({ length: input.length }, (_, i) => read(String(i)));
    } else {
      const object = record(input, 'arm data');
      const keys = Object.keys(object);
      invariant(keys.length <= 4096, 'invalid_input', 'Arm data object is too large');
      for (const key of keys) accountText(key);
      result = Object.fromEntries(keys.sort().map(key => [key, read(key)]));
    }
    ancestors.delete(input);
    return result;
  }
  const result = visit(value, 0);
  invariant(new TextEncoder().encode(JSON.stringify(result)).length <= MAX_ARM_DATA_BYTES, 'invalid_input', 'Arm data exceeds 16 KiB');
  return result;
}
export function parseArm(input: unknown): ArmDefinition {
  if (input === null || typeof input !== 'object') return { armId: id(input, 'armId') };
  const value = record(input, 'arm');
  return { armId: id(value.armId, 'armId'), ...(value.data === undefined ? {} : { data: armData(value.data) }) };
}
export function canonicalArm(input: unknown): ArmInput {
  const arm = parseArm(input);
  return arm.data === undefined ? arm.armId : arm;
}
export function checkExperimentData(arms: readonly ArmDefinition[]): void {
  const bytes = arms.reduce((sum, arm) => sum + (arm.data === undefined ? 0 : new TextEncoder().encode(JSON.stringify(arm.data)).length), 0);
  invariant(bytes <= MAX_EXPERIMENT_DATA_BYTES, 'invalid_input', 'Experiment arm data exceeds 64 KiB');
}
