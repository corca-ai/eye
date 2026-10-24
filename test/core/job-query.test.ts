import { expect, it } from 'vitest';
import { canonicalJSON, validateJobRequest } from '../../src/analytics/job-query.js';
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
