import { expect, it } from 'vitest';
import { canonicalJSON, jobCacheIdentity, validateJobRequest } from '../../src/analytics/job-query.js';
import { parseCreateExperiment } from '../../src/core/events.js';
import { AnalyticsSQL, compileFilter } from '../../src/analytics/sql.js';
import { database } from '../helpers/analytics-db.js';
import type { Filter } from '../../src/analytics/types.js';
import type { AnalyticsRequest } from '../../src/analytics/jobs.js';
it('canonicalizes object order and defaults without conflating values or array order', () => {
  expect(canonicalJSON({ b: 2, a: [1, null], ignored: undefined })).toBe(canonicalJSON({ a: [1, null], b: 2 }));
  expect(canonicalJSON([1, 2])).not.toBe(canonicalJSON([2, 1]));
  expect(canonicalJSON({ a: null })).not.toBe(canonicalJSON({}));
  const now = Date.now(), query = { from: now - 1000, to: now };
  expect(validateJobRequest('site', { kind: 'goals', query }, now)).toBe(validateJobRequest('site', { kind: 'goals', query: { ...query, limit: 100 } }, now));
  expect(() => canonicalJSON({ value: NaN })).toThrow();
  expect(() => canonicalJSON([undefined])).toThrow();
  expect(() => canonicalJSON({ value: () => 1 })).toThrow();
});

const a: Filter = { field: { key: 'x', type: 'number' }, op: 'eq', value: 1 };
const b: Filter = { field: { key: 'y', type: 'string' }, op: 'ne', value: null };
const now = 1_800_000_000_000, range = { from: now - 1000, to: now };
const identity = (filter: Filter) => jobCacheIdentity(validateJobRequest('site', { kind: 'goals', query: { ...range, filter } }, now));

it('shares Boolean equivalents while preserving executable requests and ordered dimensions', () => {
  const original = validateJobRequest('site', { kind: 'goals', query: { ...range, filter: { and: [b, a, { and: [a] }] } } }, now);
  expect(jobCacheIdentity(original)).toBe(identity({ and: [a, b] }));
  expect(JSON.parse(original).query.filter.and).toHaveLength(3);
  expect(identity({ or: [b, a, { or: [a] }] })).toBe(identity({ or: [a, b] }));
  expect(identity({ or: [a, b] })).not.toBe(identity({ and: [a, b] }));
  expect(identity({ not: { and: [b, a] } })).toBe(identity({ not: { and: [a, b] } }));
  const arm = (reverse: boolean) => validateJobRequest('site', { kind: 'arms', query: {
    ...range, experimentId: 'exp', hasEvent: { name: 'view', filter: { and: reverse ? [b, a] : [a, b] } },
  } }, now);
  expect(jobCacheIdentity(arm(true))).toBe(jobCacheIdentity(arm(false)));
  const grouped = (groupBy: { key: string; type: 'number' }[]) => jobCacheIdentity(validateJobRequest('site', {
    kind: 'arms', query: { ...range, experimentId: 'exp', groupBy },
  }, now));
  expect(grouped([{ key: 'x', type: 'number' }, { key: 'z', type: 'number' }])).not.toBe(grouped([{ key: 'z', type: 'number' }, { key: 'x', type: 'number' }]));
});

it('preserves compiled truth values for missing, null, mixed types and nested operators', () => {
  const db = database([]);
  const filters: Filter[] = [
    { and: [b, a, a] }, { or: [a, { or: [b, a] }] }, { not: { or: [b, a, a] } },
    { and: [a], not: b }, // SQL gives group operators precedence over ignored extra fields.
    ...(['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const).map(op => ({ field: { key: 'x', type: 'number' as const }, op, value: 1 })),
    { field: { key: 'x', type: 'number' }, op: 'in', value: [1, null, -1] },
    { field: { key: 'x', type: 'number' }, op: 'exists' }, { field: { key: 'x', type: 'number' }, op: 'missing' },
  ];
  try {
    for (const attributes of [{}, { x: null }, { x: '1', y: 'v' }, { x: 1 }, { x: -1, y: null }, { x: 1 + Number.EPSILON, y: false }]) {
      for (const filter of filters) {
        const normalized = JSON.parse(identity(filter)).query.filter as Filter;
        const evaluate = (value: Filter) => db.run(`WITH e AS (SELECT '${JSON.stringify(attributes)}' AS attributes_json) SELECT ${compileFilter(value, 'e')} AS result FROM e`);
        expect(evaluate(normalized)).toEqual(evaluate(filter));
      }
    }
  } finally { db.close(); }
});

it('rejects raw byte, depth and node excess before a shrinking normal form can admit it', () => {
  const large: Filter = { field: { key: 'x', type: 'string' }, op: 'eq', value: 'x'.repeat(6000) };
  expect(() => identity({ and: Array(8).fill(large) })).toThrow('32KB');
  expect(() => identity({ and: Array(64).fill(a) })).toThrow('complex');
  let nested: unknown = 0;
  for (let i = 0; i < 18; i++) nested = { ignored: nested };
  expect(() => validateJobRequest('site', { kind: 'goals', query: { ...range, ...{ ignored: nested } } }, now)).toThrow('deep');
});

it('leaves ignored hasEvent fields untouched on query kinds that do not support them', () => {
  for (const hasEvent of [null, { filter: null }, { filter: { and: null } }]) {
    const requests: AnalyticsRequest[] = [
      { kind: 'goals', query: { ...range, ...{ hasEvent } } },
      { kind: 'series', query: { ...range, bucketMs: 1000, ...{ hasEvent } } },
      { kind: 'attributeValues', query: { ...range, field: { key: 'x', type: 'number' }, ...{ hasEvent } } },
    ];
    for (const input of requests) {
      const admitted = validateJobRequest('site', input, now);
      expect(jobCacheIdentity(admitted)).toBe(admitted);
    }
  }
});

it('rejects sparse arrays before generating invalid JSON or SQL', () => {
  const missing = Array(2);
  expect.soft(() => canonicalJSON(missing)).toThrow();
  expect.soft(() => compileFilter({ and: missing }, 'e')).toThrow();
  expect.soft(() => compileFilter({ field: { key: 'x', type: 'number' }, op: 'in', value: missing }, 'e')).toThrow();
});

it('rejects sparse arm and group definitions instead of persisting or querying missing identifiers', () => {
  expect(() => parseCreateExperiment({ experimentId: 'e', arms: Array<string>(1), settings: { minHoldMs: 0 } })).toThrow('identifier');
  expect(() => new AnalyticsSQL('eye', 'site', now).arms({ ...range, experimentId: 'e', groupBy: Array(1) })).toThrow('attribute field');
});
