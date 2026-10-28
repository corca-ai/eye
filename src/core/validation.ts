import { invariant } from './errors.js';
import type { Attributes, ExperimentSettings, Subject } from './types.js';
import type { CollectionLimits } from '../collection-limits.js';

export const EVENT_MAX_AGE_MS = 15_000;
export const OBSERVATION_GRACE_MS = 60_000;
export const DAY_MS = 86_400_000;
export const RETENTION_MS = 60 * DAY_MS;
export const DEFAULT_SETTINGS = Object.freeze({
  observationWindowMs: 7 * DAY_MS,
  attributionWindowMs: 7 * DAY_MS,
  bootstrapShare: 0.2,
  attributionHalfLifeMs: DAY_MS,
  learningHalfLifeMs: 14 * DAY_MS,
  explorationFloor: 0.02,
  rewardScale: 1,
  bonusMultiplier: 2,
  bootstrapQuota: 8,
});

export function record(value: unknown, name: string): Record<string, unknown> {
  invariant(typeof value === 'object' && value !== null && !Array.isArray(value), 'invalid_input', `${name} must be an object`);
  const prototype: unknown = Object.getPrototypeOf(value);
  invariant(prototype === Object.prototype || prototype === null, 'invalid_input', `${name} must be a plain object`);
  return value as Record<string, unknown>;
}
export function id(value: unknown, name: string): string {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/u.test(value), 'invalid_input', `${name} must be a nonempty identifier of at most 256 characters`);
  invariant(!/[\uD800-\uDFFF]/u.test(value), 'invalid_input', `${name} must contain valid Unicode`);
  return value;
}
export function sampleId(value: unknown): string {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f]/u.test(value), 'invalid_input', 'Invalid sample ID');
  invariant(!/[\uD800-\uDFFF]/u.test(value), 'invalid_input', 'Sample ID must contain valid Unicode');
  return value;
}
export function number(value: unknown, name: string): number {
  invariant(typeof value === 'number' && Number.isFinite(value), 'invalid_input', `${name} must be a finite number`);
  return value;
}
export function timestamp(value: unknown, name: string): number {
  const result = number(value, name);
  invariant(Number.isSafeInteger(result) && result >= 0, 'invalid_input', `${name} must be nonnegative integer Unix milliseconds`);
  return result;
}
export function subject(value: unknown): Subject {
  const v = record(value, 'subject');
  const cid = id(v.cid, 'subject.cid');
  return v.uid === undefined ? { cid } : { cid, uid: id(v.uid, 'subject.uid') };
}
export function attributes(value: unknown, limits?: Pick<CollectionLimits, 'maxAttributeKeys' | 'maxAttributeStringLength'>): Attributes {
  const v = record(value, 'attributes');
  const entries: [string, string | number | boolean | null][] = [];
  // Read each value once; stop before allocating/sorting the full input or serializing it.
  for (const key in v) {
    if (!Object.hasOwn(v, key)) continue;
    if (limits) invariant(entries.length < limits.maxAttributeKeys, 'invalid_input', 'Too many attribute keys');
    id(key, 'attribute key');
    const item = v[key];
    if (limits) invariant(typeof item !== 'string' || item.length <= limits.maxAttributeStringLength,
      'invalid_input', 'Attribute string exceeds collection limit');
    invariant(item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)), 'invalid_input', `Attribute ${key} must be a finite scalar or null`);
    entries.push([key, item]);
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
export function settings(value: unknown): ExperimentSettings {
  const v = record(value, 'settings');
  for (const key of Object.keys(v)) {
    invariant(key === 'minHoldMs' || Object.hasOwn(DEFAULT_SETTINGS, key), 'invalid_input', `Unknown setting: ${key}`);
  }
  const read = (key: keyof typeof DEFAULT_SETTINGS) => number(v[key] === undefined ? DEFAULT_SETTINGS[key] : v[key], key);
  const result: ExperimentSettings = {
    minHoldMs: number(v.minHoldMs, 'minHoldMs'),
    attributionWindowMs: read('attributionWindowMs'), bootstrapShare: read('bootstrapShare'),
    observationWindowMs: read('observationWindowMs'), attributionHalfLifeMs: read('attributionHalfLifeMs'),
    learningHalfLifeMs: read('learningHalfLifeMs'),
    explorationFloor: read('explorationFloor'), rewardScale: read('rewardScale'),
    bonusMultiplier: read('bonusMultiplier'),
    bootstrapQuota: read('bootstrapQuota'),
  };
  for (const [key, n] of Object.entries(result)) {
    const zeroAllowed = key === 'minHoldMs';
    invariant(zeroAllowed ? n >= 0 : n > 0, 'invalid_input', `${key} must be ${zeroAllowed ? 'nonnegative' : 'positive'}`);
    if (key.endsWith('Ms')) invariant(Number.isSafeInteger(n), 'invalid_input', `${key} must be integer milliseconds`);
  }
  invariant(result.explorationFloor <= 1, 'invalid_input', 'explorationFloor must be at most 1');
  invariant(result.observationWindowMs + OBSERVATION_GRACE_MS <= RETENTION_MS, 'invalid_input', 'observationWindowMs + fixed one-minute grace must not exceed 60 days');
  invariant(Number.isSafeInteger(result.bootstrapQuota), 'invalid_input', 'bootstrapQuota must be an integer');
  invariant(result.attributionWindowMs! <= RETENTION_MS && result.bootstrapShare! < 1, 'invalid_input', 'Attribution horizon must be at most 60 days and bootstrapShare below one');
  return result;
}

/** Decode historical assignments/configs; the removed setting never affects the fixed grace. */
export function historicalSettings(value: unknown): ExperimentSettings {
  const v = record(value, 'settings');
  return settings(Object.fromEntries(Object.entries(v).filter(([key]) => key !== 'allowedLatenessMs')));
}

/** JSON tuple encoding prevents collisions between user-controlled site/subject IDs. */
export function subjectKey(siteId: string, value: Subject): string {
  return JSON.stringify([siteId, value.uid === undefined ? 'cid' : 'uid', value.uid ?? value.cid]);
}
