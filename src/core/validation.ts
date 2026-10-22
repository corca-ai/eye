import { invariant } from './errors.js';
import type { Attributes, ExperimentSettings, Subject } from './types.js';

export const DAY_MS = 86_400_000;
export const RETENTION_MS = 60 * DAY_MS;
export const DEFAULT_SETTINGS = Object.freeze({
  observationWindowMs: 7 * DAY_MS,
  attributionHalfLifeMs: DAY_MS,
  learningHalfLifeMs: 14 * DAY_MS,
  allowedLatenessMs: 3_600_000,
  explorationFloor: 0.02,
  rewardScale: 1,
  bonusMultiplier: 2,
  pendingPenalty: 1,
  bootstrapQuota: 8,
  reservationTtlMs: 300_000,
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
export function attributes(value: unknown): Attributes {
  const v = record(value, 'attributes');
  const entries: [string, string | number | boolean | null][] = [];
  for (const [key, item] of Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    id(key, 'attribute key');
    invariant(item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)), 'invalid_input', `Attribute ${key} must be a finite scalar or null`);
    entries.push([key, item]);
  }
  return Object.fromEntries(entries);
}
export function settings(value: unknown): ExperimentSettings {
  const v = record(value, 'settings');
  for (const key of Object.keys(v)) {
    invariant(key === 'minHoldMs' || Object.hasOwn(DEFAULT_SETTINGS, key), 'invalid_input', `Unknown setting: ${key}`);
  }
  const read = (key: keyof typeof DEFAULT_SETTINGS) => number(v[key] === undefined ? DEFAULT_SETTINGS[key] : v[key], key);
  const result: ExperimentSettings = {
    minHoldMs: number(v.minHoldMs, 'minHoldMs'),
    observationWindowMs: read('observationWindowMs'), attributionHalfLifeMs: read('attributionHalfLifeMs'),
    learningHalfLifeMs: read('learningHalfLifeMs'), allowedLatenessMs: read('allowedLatenessMs'),
    explorationFloor: read('explorationFloor'), rewardScale: read('rewardScale'),
    bonusMultiplier: read('bonusMultiplier'), pendingPenalty: read('pendingPenalty'),
    bootstrapQuota: read('bootstrapQuota'), reservationTtlMs: read('reservationTtlMs'),
  };
  for (const [key, n] of Object.entries(result)) {
    const zeroAllowed = key === 'minHoldMs' || key === 'allowedLatenessMs';
    invariant(zeroAllowed ? n >= 0 : n > 0, 'invalid_input', `${key} must be ${zeroAllowed ? 'nonnegative' : 'positive'}`);
    if (key.endsWith('Ms')) invariant(Number.isSafeInteger(n), 'invalid_input', `${key} must be integer milliseconds`);
  }
  invariant(result.explorationFloor <= 1, 'invalid_input', 'explorationFloor must be at most 1');
  invariant(result.observationWindowMs + result.allowedLatenessMs <= RETENTION_MS, 'invalid_input', 'observationWindowMs + allowedLatenessMs must not exceed 60 days');
  invariant(Number.isSafeInteger(result.bootstrapQuota), 'invalid_input', 'bootstrapQuota must be an integer');
  return result;
}

/** JSON tuple encoding prevents collisions between user-controlled site/subject IDs. */
export function subjectKey(siteId: string, value: Subject): string {
  return JSON.stringify([siteId, value.uid === undefined ? 'cid' : 'uid', value.uid ?? value.cid]);
}
export function experimentKey(siteId: string, experimentId: string): string {
  return JSON.stringify([siteId, experimentId]);
}
