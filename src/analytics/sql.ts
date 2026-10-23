import { invariant } from '../core/errors.js';
import { id, record, timestamp, RETENTION_MS } from '../core/validation.js';
import type { AnalyticsTable } from './records.js';
import type { ArmQuery, AttributeValuesQuery, GoalQuery, QueryRange, SeriesQuery, TimelineQuery } from './types.js';

export interface QueryPlan { sql: string; limit: number; receivedBefore: number; fingerprint: string }
export interface Cursor { fingerprint: string; receivedBefore: number; at: number; table: string; id: string }
export const TABLES: readonly AnalyticsTable[] = ['events', 'observations', 'credits', 'decisions', 'identity_links', 'policies', 'attribute_keys'];

export function literal(value: string | number | boolean | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') { invariant(Number.isFinite(value), 'invalid_input', 'SQL values must be finite'); return String(value); }
  invariant(typeof value === 'string' && value.length <= 10_000 && !value.includes('\0'), 'invalid_input', 'Invalid SQL string value');
  return `'${value.replaceAll("'", "''")}'`;
}
function identifier(value: string): string {
  invariant(typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value), 'invalid_input', 'Invalid analytics namespace');
  return `"${value}"`;
}
function field(input: unknown, alias: string): { sql: string; type: string; key: string } {
  const f = record(input, 'attribute field'), key = id(f.key, 'attribute key');
  invariant(f.type === 'string' || f.type === 'number' || f.type === 'boolean', 'invalid_input', 'Invalid attribute type');
  const fn = f.type === 'string' ? 'json_get_str' : f.type === 'number' ? 'json_get_float' : 'json_get_bool';
  return { sql: `${fn}(${alias}.attributes_json, ${literal(key)})`, type: f.type, key };
}
/** Values never enter SQL as identifiers or expressions. Typed extractors do not coerce strings to numbers. */
export function compileFilter(input: unknown, alias: string): string {
  let nodes = 0;
  const visit = (value: unknown, depth: number): string => {
    invariant(++nodes <= 64 && depth <= 8, 'invalid_input', 'Filter is too complex');
    const v = record(value, 'filter');
    if ('and' in v || 'or' in v) {
      invariant(!('and' in v && 'or' in v), 'invalid_input', 'Ambiguous filter');
      const op = 'and' in v ? 'and' : 'or', children = v[op];
      invariant(Array.isArray(children) && children.length > 0 && children.length <= 64, 'invalid_input', 'Filter group must contain 1–64 children');
      return `(${children.map(child => visit(child, depth + 1)).join(op === 'and' ? ' AND ' : ' OR ')})`;
    }
    if ('not' in v) return `(NOT ${visit(v.not, depth + 1)})`;
    const f = field(v.field, alias);
    if (v.op === 'exists' || v.op === 'missing') return `${v.op === 'missing' ? 'NOT ' : ''}json_contains(${alias}.attributes_json, ${literal(f.key)})`;
    const checked = (item: unknown): string => {
      invariant(item === null || typeof item === f.type, 'invalid_input', 'Filter value does not match the declared attribute type');
      invariant(item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean', 'invalid_input', 'Invalid filter scalar');
      return literal(item);
    };
    const equality = (item: unknown): string => item === null
      ? `(json_contains(${alias}.attributes_json, ${literal(f.key)}) AND json_get_json(${alias}.attributes_json, ${literal(f.key)}) = 'null')`
      : `COALESCE(${f.sql} = ${checked(item)}, FALSE)`;
    if (v.op === 'eq' || v.op === 'ne') { const equal = equality(v.value); return v.op === 'eq' ? equal : `(NOT ${equal})`; }
    if (v.op === 'in') {
      invariant(Array.isArray(v.value) && v.value.length > 0 && v.value.length <= 100, 'invalid_input', 'in requires 1–100 values');
      return `(${v.value.map(equality).join(' OR ')})`;
    }
    invariant(v.op === 'lt' || v.op === 'lte' || v.op === 'gt' || v.op === 'gte', 'invalid_input', 'Invalid filter operator');
    invariant(f.type === 'number' && typeof v.value === 'number', 'invalid_input', 'Ordered comparison requires a number');
    const op = { lt: '<', lte: '<=', gt: '>', gte: '>=' }[v.op];
    return `COALESCE(${f.sql} ${op} ${checked(v.value)}, FALSE)`;
  };
  return visit(input, 0);
}
function range(input: QueryRange, now: number): number {
  record(input, 'query'); timestamp(input.from, 'from'); timestamp(input.to, 'to');
  invariant(input.from >= now - RETENTION_MS && input.from < input.to && input.to <= now, 'outside_retention', 'Choose a nonempty interval within the last 60 days');
  const limit = input.limit ?? 100;
  invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000, 'invalid_input', 'limit must be 1–1000');
  return limit;
}
function fingerprint(site: string, kind: string, input: object): string { return JSON.stringify([site, kind, input]); }
export function decodeCursor(raw: string): Cursor {
  invariant(typeof raw === 'string' && raw.length <= 30_000, 'invalid_input', 'Invalid timeline cursor');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { invariant(false, 'invalid_input', 'Invalid timeline cursor'); }
  const c = record(parsed, 'cursor');
  invariant(typeof c.fingerprint === 'string' && typeof c.table === 'string' && TABLES.some(t => t === c.table) && typeof c.id === 'string', 'invalid_input', 'Invalid timeline cursor');
  return { fingerprint: c.fingerprint, receivedBefore: timestamp(c.receivedBefore, 'cursor receivedBefore'), at: timestamp(c.at, 'cursor at'), table: c.table, id: c.id };
}
export class AnalyticsSQL {
  private readonly namespace: string;
  constructor(namespace: string, private readonly siteId: string, private readonly now = Date.now()) { this.namespace = identifier(namespace); id(siteId, 'siteId'); }
  private latest(table: AnalyticsTable, alias: string, from: number, to: number, receivedBefore: number, extra = ''): string {
    return `${alias} AS (SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY revision DESC, received_at DESC) AS _revision_rank
FROM ${this.namespace}."${table}" WHERE site_id = ${literal(this.siteId)} AND occurred_at >= ${from} AND occurred_at < ${to} AND received_at <= ${receivedBefore}${extra}) ranked WHERE _revision_rank = 1)`;
  }
  arms(q: ArmQuery, bucketMs?: number): QueryPlan {
    if (bucketMs !== undefined) invariant(Number.isSafeInteger(bucketMs) && bucketMs > 0, 'invalid_input', 'bucketMs must be positive integer milliseconds');
    const limit = range(q, this.now), experiment = literal(id(q.experimentId, 'experimentId'));
    invariant(q.generation === undefined || (Number.isSafeInteger(q.generation) && q.generation >= 1), 'invalid_input', 'generation must be a positive integer');
    const groups = q.groupBy ?? [];
    invariant(Array.isArray(groups) && groups.length <= 3, 'invalid_input', 'At most 3 groupBy fields are supported');
    const fields = groups.map((f, i) => `${field(f, 'o').sql} AS group_${i}`);
    const dimensions = [...(bucketMs === undefined ? [] : ['bucket_start']), 'arm_id', 'generation', 'window_ms', ...groups.map((_, i) => `group_${i}`)];
    const ctes = [this.latest('observations', 'observations_latest', q.from, q.to, this.now, ` AND experiment_id = ${experiment}${q.armId === undefined ? '' : ` AND arm_id = ${literal(id(q.armId, 'armId'))}`}${q.generation === undefined ? '' : ` AND json_get_int(payload_json, 'generation') = ${q.generation}`}`)];
    ctes.push(this.latest('identity_links', 'identity_latest', 0, this.now + 1, this.now));
    ctes.push(`state_merges AS (SELECT json_get_str(payload_json, 'sourceStateKey') AS source_key,
json_get_str(payload_json, 'targetStateKey') AS target_key, occurred_at AS joined_at FROM identity_latest WHERE status = 'merged')`);
    let reward = 'o.value', join = ' LEFT JOIN state_merges om ON om.source_key = o.state_key', hasEvent = '';
    if (q.goalId !== undefined) {
      ctes.push(this.latest('credits', 'credits_latest', q.from, this.now + 1, this.now, ` AND experiment_id = ${experiment}`));
      ctes.push(`goal_rewards AS (SELECT observation_id, SUM(value) AS reward FROM credits_latest WHERE status = 'eligible' AND goal_id = ${literal(id(q.goalId, 'goalId'))} GROUP BY observation_id)`);
      reward = 'COALESCE(g.reward, 0)'; join += ' LEFT JOIN goal_rewards g ON g.observation_id = o.observation_id';
    }
    if (q.hasEvent !== undefined) {
      const event = record(q.hasEvent, 'hasEvent');
      ctes.push(this.latest('events', 'events_latest', q.from, this.now + 1, this.now));
      // Immutable assignment id is not sufficient: an assignment can have multiple observation windows.
      hasEvent = ` AND EXISTS (SELECT 1 FROM events_latest e LEFT JOIN state_merges em ON em.source_key = e.state_key WHERE (e.state_key = o.state_key OR (COALESCE(em.target_key, e.state_key) = COALESCE(om.target_key, o.state_key) AND e.occurred_at >= COALESCE(em.joined_at, 0) AND e.occurred_at >= COALESCE(om.joined_at, 0))) AND e.occurred_at >= o.occurred_at AND e.occurred_at < json_get_int(o.payload_json, 'endAt') AND json_get_str(e.payload_json, 'kind') = 'track' AND json_get_str(e.payload_json, 'name') = ${literal(id(event.name, 'event name'))}${event.filter === undefined ? '' : ` AND ${compileFilter(event.filter, 'e')}`})`;
    }
    ctes.push(`cohort AS (SELECT ${bucketMs === undefined ? '' : `CAST(FLOOR(o.occurred_at / ${bucketMs}.0) * ${bucketMs} AS BIGINT) AS bucket_start, `}o.arm_id, json_get_int(o.payload_json, 'generation') AS generation,
json_get_int(o.payload_json, 'endAt') - o.occurred_at AS window_ms, o.status, COALESCE(om.target_key, o.state_key) AS state_key, o.received_at,
CASE WHEN o.status = 'complete' THEN ${reward} ELSE 0 END AS reward${fields.length ? `, ${fields.join(', ')}` : ''}
FROM observations_latest o${join} WHERE TRUE${q.filter === undefined ? '' : ` AND ${compileFilter(q.filter, 'o')}`}${hasEvent})`);
    const sql = `WITH ${ctes.join(',\n')}
SELECT ${dimensions.join(', ')}, SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed,
SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END) AS interrupted,
COUNT(DISTINCT state_key) AS subjects, SUM(reward) AS total_value,
AVG(CASE WHEN status = 'complete' THEN reward ELSE NULL END) AS mean_value, MAX(received_at) AS latest_received_at
FROM cohort GROUP BY ${dimensions.join(', ')} ORDER BY ${dimensions.join(', ')} LIMIT ${limit + 1}`;
    return { sql, limit, receivedBefore: this.now, fingerprint: fingerprint(this.siteId, 'arms', q) };
  }
  timeline(q: TimelineQuery): QueryPlan {
    const limit = range(q, this.now), subject = record(q.subject, 'timeline subject');
    invariant((subject.cid !== undefined) !== (subject.uid !== undefined), 'invalid_input', 'Supply exactly one cid or uid');
    invariant(q.includeLinked === undefined || typeof q.includeLinked === 'boolean', 'invalid_input', 'includeLinked must be boolean');
    const key = subject.uid === undefined ? 'cid' : 'uid', value = literal(id(subject[key], key));
    const fp = fingerprint(this.siteId, 'timeline', { from: q.from, to: q.to, subject: { [key]: subject[key] }, includeLinked: q.includeLinked !== false });
    const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
    invariant(!cursor || (cursor.fingerprint === fp && cursor.receivedBefore <= this.now && cursor.at >= q.from && cursor.at < q.to), 'invalid_input', 'Cursor does not belong to this query');
    const receivedBefore = cursor?.receivedBefore ?? this.now;
    // An interval can begin before the 60-day event horizon and still be active now.
    const ctes = [this.latest('identity_links', 'links', 0, q.to, receivedBefore)];
    const linked = key === 'uid' && q.includeLinked !== false;
    for (const table of TABLES.filter(t => t !== 'identity_links' && t !== 'policies' && t !== 'attribute_keys')) {
      // Subject membership is applied after revision deduplication; revisions may change identity metadata.
      ctes.push(this.latest(table, `${table}_latest`, q.from, q.to, receivedBefore));
    }
    ctes.push(`all_records AS (${TABLES.filter(t => t !== 'policies' && t !== 'attribute_keys').map(table => `SELECT * FROM ${table === 'identity_links' ? 'links' : `${table}_latest`}`).join(' UNION ALL ')})`);
    const after = cursor ? ` AND (r.occurred_at > ${cursor.at} OR (r.occurred_at = ${cursor.at} AND (r.table_name > ${literal(cursor.table)} OR (r.table_name = ${literal(cursor.table)} AND r.record_id > ${literal(cursor.id)}))))` : '';
    const sql = `WITH ${ctes.join(',\n')} SELECT r.* FROM all_records r WHERE r.occurred_at >= ${q.from} AND r.occurred_at < ${q.to}
AND (r.${key} = ${value}${linked ? ` OR (r.uid IS NULL AND EXISTS (SELECT 1 FROM links l WHERE l.status = 'active' AND l.uid = ${value} AND l.cid = r.cid AND r.occurred_at >= l.occurred_at AND (json_get_int(l.payload_json, 'linkedUntil') IS NULL OR r.occurred_at < json_get_int(l.payload_json, 'linkedUntil'))))` : ''})${after}
ORDER BY r.occurred_at, r.table_name, r.record_id LIMIT ${limit + 1}`;
    return { sql, limit, receivedBefore, fingerprint: fp };
  }
  goals(q: GoalQuery): QueryPlan { return this.goalAggregate(q); }
  series(q: SeriesQuery): QueryPlan {
    record(q, 'query');
    invariant(Number.isSafeInteger(q.bucketMs) && q.bucketMs > 0, 'invalid_input', 'bucketMs must be positive integer milliseconds');
    return this.goalAggregate(q, q.bucketMs);
  }
  private goalAggregate(q: GoalQuery, bucketMs?: number): QueryPlan {
    const limit = range(q, this.now), dimensions = bucketMs === undefined ? 'e.goal_id' : `CAST(FLOOR(e.occurred_at / ${bucketMs}.0) * ${bucketMs} AS BIGINT), e.goal_id`;
    const select = bucketMs === undefined ? 'e.goal_id' : `CAST(FLOOR(e.occurred_at / ${bucketMs}.0) * ${bucketMs} AS BIGINT) AS bucket_start, e.goal_id`;
    return { sql: `WITH ${this.latest('events', 'events_latest', q.from, q.to, this.now)}
SELECT ${select}, COUNT(*) AS events, SUM(e.value) AS total_value, MAX(e.received_at) AS latest_received_at
FROM events_latest e WHERE e.status = 'accepted' AND json_get_str(e.payload_json, 'kind') = 'goal'${q.goalId === undefined ? '' : ` AND e.goal_id = ${literal(id(q.goalId, 'goalId'))}`}${q.filter === undefined ? '' : ` AND ${compileFilter(q.filter, 'e')}`}
GROUP BY ${dimensions} ORDER BY ${bucketMs === undefined ? 'e.goal_id' : 'bucket_start, e.goal_id'} LIMIT ${limit + 1}`, limit, receivedBefore: this.now, fingerprint: fingerprint(this.siteId, 'goals', q) };
  }
  traffic(q: import('./types.js').TrafficQuery): QueryPlan {
    const limit = range(q, this.now), experiment = literal(id(q.experimentId, 'experimentId'));
    invariant(Number.isSafeInteger(q.bucketMs) && q.bucketMs > 0, 'invalid_input', 'bucketMs must be positive integer milliseconds');
    const ctes = [this.latest('events', 'events_latest', q.from, q.to, this.now, ` AND experiment_id = ${experiment}`),
      this.latest('decisions', 'decisions_latest', q.from, q.to, this.now, ` AND experiment_id = ${experiment}`)];
    const dimension = `CAST(FLOOR(occurred_at / ${q.bucketMs}.0) * ${q.bucketMs} AS BIGINT) AS bucket_start, arm_id, json_get_int(json_get_json(payload_json, 'assignment'), 'generation') AS generation`;
    const sql = `WITH ${ctes.join(',')}, traffic AS (
SELECT ${dimension}, 1 AS assignments, 0 AS exposures FROM decisions_latest WHERE json_get_str(payload_json, 'reason') = 'selected'
UNION ALL SELECT ${dimension}, 0 AS assignments, 1 AS exposures FROM events_latest WHERE json_get_str(payload_json, 'kind') = 'exposure'
), totals AS (SELECT bucket_start, arm_id, generation, SUM(assignments) AS assignments, SUM(exposures) AS exposures FROM traffic GROUP BY bucket_start, arm_id, generation)
SELECT *, assignments * 1.0 / NULLIF(SUM(assignments) OVER (PARTITION BY bucket_start, generation), 0) AS assignment_share,
exposures * 1.0 / NULLIF(SUM(exposures) OVER (PARTITION BY bucket_start, generation), 0) AS exposure_share
FROM totals ORDER BY bucket_start, generation, arm_id LIMIT ${limit + 1}`;
    return { sql, limit, receivedBefore: this.now, fingerprint: fingerprint(this.siteId, 'traffic', q) };
  }
  policies(q: import('./types.js').PolicyQuery): QueryPlan {
    const limit = range(q, this.now);
    return { sql: `WITH ${this.latest('policies', 'policies_latest', q.from, q.to, this.now, ` AND experiment_id = ${literal(id(q.experimentId, 'experimentId'))}`)}
SELECT * FROM policies_latest${q.armId === undefined ? '' : ` WHERE arm_id = ${literal(id(q.armId, 'armId'))}`} ORDER BY occurred_at, record_id LIMIT ${limit + 1}`, limit, receivedBefore: this.now, fingerprint: fingerprint(this.siteId, 'policies', q) };
  }
  attributeKeys(q: QueryRange): QueryPlan {
    const limit = range(q, this.now);
    return { sql: `WITH ${this.latest('attribute_keys', 'keys_latest', Math.floor(q.from / 86_400_000) * 86_400_000, Math.ceil(q.to / 86_400_000) * 86_400_000, this.now)}
SELECT json_get_str(payload_json, 'key') AS attribute_key, json_get_str(payload_json, 'type') AS attribute_type,
json_get_str(payload_json, 'source') AS attribute_source, MAX(received_at) AS latest_received_at
FROM keys_latest GROUP BY json_get_str(payload_json, 'key'), json_get_str(payload_json, 'type'), json_get_str(payload_json, 'source')
ORDER BY attribute_key, attribute_type, attribute_source LIMIT ${limit + 1}`, limit, receivedBefore: this.now, fingerprint: fingerprint(this.siteId, 'attributeKeys', q) };
  }
  attributeValues(q: AttributeValuesQuery): QueryPlan {
    const limit = range(q, this.now), attribute = field(q.field, 'e').sql;
    return { sql: `WITH ${this.latest('events', 'events_latest', q.from, q.to, this.now)}
SELECT ${attribute} AS attribute_value, COUNT(*) AS events, MAX(e.received_at) AS latest_received_at
FROM events_latest e${q.filter === undefined ? '' : ` WHERE ${compileFilter(q.filter, 'e')}`} GROUP BY ${attribute} ORDER BY events DESC, attribute_value LIMIT ${limit + 1}`, limit, receivedBefore: this.now, fingerprint: fingerprint(this.siteId, 'attributeValues', q) };
  }
}
