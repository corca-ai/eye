import { AnalyticsSQL } from './sql.js';
import { invariant } from '../core/errors.js';
import type { AnalyticsRequest, AnalyticsResult } from './jobs.js';
import type { BasinAnalytics } from './query.js';
import { validateSummaryQuery } from './summary-query.js';
import type { Filter } from './types.js';

/** Sort object keys, keep array order/explicit nulls, and reject values JSON would
 * silently erase. Query validation runs before a key is computed. */
export function canonicalJSON(value: unknown, depth = 0): string {
  invariant(depth <= 16, 'invalid_input', 'Query nesting is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { invariant(Number.isFinite(value), 'invalid_input', 'Invalid query number'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(v => canonicalJSON(v, depth + 1)).join(',')}]`;
  invariant(typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype,
    'invalid_input', 'Query must contain plain JSON values');
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v, depth + 1)}`).join(',')}}`;
}
export function validateJobRequest(siteId: string, input: AnalyticsRequest, now: number): string {
  invariant(input && typeof input === 'object' && input.query && typeof input.query === 'object', 'invalid_input', 'Invalid analytics request');
  const sql = new AnalyticsSQL('eye', siteId, now);
  switch (input.kind) {
    case 'summary': break; // Normalized and validated below; no raw SQL builder.
    case 'learning': sql.learning(input.query); break;
    case 'arms': sql.arms(input.query); break;
    case 'armSeries':
      invariant(Number.isSafeInteger(input.query.bucketMs) && input.query.bucketMs > 0, 'invalid_input', 'bucketMs must be positive integer milliseconds');
      sql.arms(input.query, input.query.bucketMs); break;
    case 'traffic': sql.traffic(input.query); break;
    case 'policies': sql.policies(input.query); break;
    case 'attributeKeys': sql.attributeKeys(input.query); break;
    case 'timeline': sql.timeline(input.query); break;
    case 'goals': sql.goals(input.query); break;
    case 'series': sql.series(input.query); break;
    case 'attributeValues': sql.attributeValues(input.query); break;
    default: invariant(false, 'invalid_input', 'Unknown analytics kind');
  }
  const normalized = input.kind === 'summary' ? { kind: input.kind, query: validateSummaryQuery(input.query, now) }
    : { ...input, query: { ...input.query, limit: input.query.limit ?? 100 } };
  const json = canonicalJSON(normalized);
  invariant(new TextEncoder().encode(json).length <= 32_000, 'invalid_input', 'Analytics request exceeds 32KB');
  return json;
}

function normalizeFilter(filter: Filter): Filter {
  if (!('and' in filter) && !('or' in filter)) return 'not' in filter ? { not: normalizeFilter(filter.not) } : filter;
  const conjunction = 'and' in filter;
  const children = (conjunction ? filter.and : filter.or).map(normalizeFilter).flatMap(child =>
    conjunction && 'and' in child ? child.and : !conjunction && 'or' in child ? child.or : [child]);
  const unique = new Map(children.map(child => [canonicalJSON(child), child]));
  const ordered = [...unique].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, child]) => child);
  return ordered.length === 1 ? ordered[0]! : conjunction ? { and: ordered } : { or: ordered };
}

/** Cache-only representation of a request already admitted by validateJobRequest.
 * Keep the original serialized request for execution and page().request. */
export function jobCacheIdentity(request: string): string {
  const input = JSON.parse(request) as AnalyticsRequest;
  if (input.kind !== 'arms' && input.kind !== 'armSeries' && input.kind !== 'goals'
    && input.kind !== 'series' && input.kind !== 'attributeValues') return request;
  const query = input.query;
  const hasEvent = input.kind === 'arms' || input.kind === 'armSeries' ? input.query.hasEvent : undefined;
  return canonicalJSON({ ...input, query: { ...query,
    ...(query.filter === undefined ? {} : { filter: normalizeFilter(query.filter) }),
    ...(hasEvent === undefined ? {} : { hasEvent: { ...hasEvent,
      ...(hasEvent.filter === undefined ? {} : { filter: normalizeFilter(hasEvent.filter) }),
    } }),
  } });
}
export async function runJobQuery(api: BasinAnalytics, input: Exclude<AnalyticsRequest, { kind: 'summary' }>): Promise<AnalyticsResult> {
  switch (input.kind) {
    case 'learning': return { kind: input.kind, data: await api.learning(input.query) };
    case 'arms': return { kind: input.kind, data: await api.arms(input.query) };
    case 'armSeries': return { kind: input.kind, data: await api.armSeries(input.query) };
    case 'traffic': return { kind: input.kind, data: await api.traffic(input.query) };
    case 'policies': return { kind: input.kind, data: await api.policies(input.query) };
    case 'attributeKeys': return { kind: input.kind, data: await api.attributeKeys(input.query) };
    case 'timeline': return { kind: input.kind, data: await api.timeline(input.query) };
    case 'goals': return { kind: input.kind, data: await api.goals(input.query) };
    case 'series': return { kind: input.kind, data: await api.series(input.query) };
    case 'attributeValues': return { kind: input.kind, data: await api.attributeValues(input.query) };
  }
}
