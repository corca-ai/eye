import type { SummaryQuery, SummaryTarget } from './summaries.js';
import { invariant } from '../core/errors.js';
import { id, record, timestamp } from '../core/validation.js';

export const SUMMARY_HOUR_MS = 3_600_000;
export function validateSummaryTarget(input: unknown): SummaryTarget {
  const obj = record(input, 'summary target');
  invariant(obj.kind === 'goals' || obj.kind === 'learning', 'invalid_input', 'Invalid summary kind');
  const field = obj.kind === 'goals' ? 'goalId' : 'experimentId';
  invariant(Object.keys(obj).every(key => key === 'kind' || key === field), 'invalid_input', 'Unsupported summary option');
  const target = id(obj[field], 'summary target');
  return obj.kind === 'goals' ? { kind: 'goals', goalId: target } : { kind: 'learning', experimentId: target };
}
/** Coverage is checked by the site at execution; never fall back to raw queries. */
export function validateSummaryQuery(input: unknown, now: number): SummaryQuery {
  const { from: start, to: end, ...target } = record(input, 'summary query');
  const parsed = validateSummaryTarget(target), from = timestamp(start, 'from'), to = timestamp(end, 'to');
  invariant(from < to && from % SUMMARY_HOUR_MS === 0 && to % SUMMARY_HOUR_MS === 0 &&
    to <= Math.floor(now / SUMMARY_HOUR_MS) * SUMMARY_HOUR_MS && to - from <= 59 * 24 * SUMMARY_HOUR_MS,
  'invalid_input', 'Summary ranges require whole completed UTC hours, at most 59 days');
  return { ...parsed, from, to };
}
