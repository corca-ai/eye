import { armData } from './core/arm-data.js';
import { invariant } from './core/errors.js';
import { id, number, record, sampleId, timestamp } from './core/validation.js';
import type { BrowserChoice, BrowserEventResult, BrowserSample, BrowserSnapshot, BrowserState } from './browser-types.js';

function text(value: unknown, name: string): string {
  invariant(typeof value === 'string', 'invalid_input', `${name} must be a string`);
  return value;
}
function sample(value: unknown): BrowserSample {
  const v = record(value, 'browser sample');
  return {sampleId: sampleId(v.sampleId), startAt: timestamp(v.startAt, 'sample.startAt')};
}
export function browserState(value: unknown): BrowserState {
  const v = record(value, 'browser state');
  return {receipt: text(v.receipt, 'receipt'), ...(v.sample === undefined ? {} : {sample: sample(v.sample)})};
}
function browserChoice(value: unknown): BrowserChoice {
  const v = record(value, 'browser choice');
  const allocation = v.allocation;
  invariant(allocation === undefined || allocation === 'policy' || allocation === 'default', 'invalid_input', 'Invalid browser allocation');
  const observationWindowMs = v.observationWindowMs === undefined ? undefined : timestamp(v.observationWindowMs, 'observationWindowMs');
  invariant(observationWindowMs === undefined || observationWindowMs > 0, 'invalid_input', 'Observation window must be positive');
  return {...browserState(v), experimentId: id(v.experimentId, 'experimentId'), armId: id(v.armId, 'armId'),
    applyUntil: number(v.applyUntil, 'applyUntil'),
    ...(v.refreshAfter === undefined ? {} : {refreshAfter: number(v.refreshAfter, 'refreshAfter')}),
    ...(v.assignmentId === undefined ? {} : {assignmentId: id(v.assignmentId, 'assignmentId')}),
    ...(v.contextKey === undefined ? {} : {contextKey: text(v.contextKey, 'contextKey')}),
    ...(observationWindowMs === undefined ? {} : {observationWindowMs}),
    ...(allocation === undefined ? {} : {allocation}),
    ...(v.data === undefined ? {} : {data: armData(v.data)})};
}
function choices(value: unknown): BrowserChoice[] {
  invariant(Array.isArray(value), 'invalid_input', 'Browser choices must be an array');
  return Array.from(value, browserChoice);
}
export function browserSnapshot(value: unknown): BrowserSnapshot {
  const v = record(value, 'browser snapshot');
  const statuses = v.statuses === undefined ? undefined : Object.fromEntries(Object.entries(record(v.statuses, 'browser statuses')).map(([key, status]) => {
    invariant(status === 'assigned' || status === 'inactive' || status === 'unavailable', 'invalid_input', 'Invalid browser status');
    return [key, status] as const;
  }));
  return {scope: text(v.scope, 'scope'), serverNow: number(v.serverNow, 'serverNow'), choices: choices(v.choices),
    ...(v.defaults === undefined ? {} : {defaults: choices(v.defaults)}), ...(statuses === undefined ? {} : {statuses})};
}
export function browserResults(value: unknown): BrowserEventResult[] {
  invariant(Array.isArray(value), 'invalid_input', 'Browser acknowledgement must be an array');
  return Array.from(value, item => {
    const v = record(item, 'browser acknowledgement');
    invariant(typeof v.accepted === 'boolean', 'invalid_input', 'Invalid browser acknowledgement');
    return {eventId: id(v.eventId, 'eventId'), accepted: v.accepted};
  });
}
/** A saved default may be a receipt alone; cached timing is usable only as a complete set. */
export type StoredDefault = BrowserState & (
  | {choice?: never; serverNow?: never; receivedWall?: never; safetyMs?: never}
  | {choice: BrowserChoice; serverNow: number; receivedWall: number; safetyMs: number}
);
export function storedDefault(value: unknown): StoredDefault {
  const v = record(value, 'stored default'), state = browserState(v);
  if (v.choice === undefined) return state;
  const safetyMs = number(v.safetyMs, 'safetyMs');
  invariant(safetyMs >= 0, 'invalid_input', 'Invalid stored timing margin');
  return {...state, choice: browserChoice(v.choice), serverNow: number(v.serverNow, 'serverNow'),
    receivedWall: number(v.receivedWall, 'receivedWall'), safetyMs};
}
