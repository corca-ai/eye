import { intervalAttributionCTEs } from './interval-attribution-sql.js';
import { identityBoundaryCTEs } from './identity-boundaries-sql.js';

/** Internal query scope; values and identifiers are already validated/quoted. */
export interface AttributionScope { key: 'cid' | 'uid'; value: string; includeLinked: boolean }

/** SQL counterpart of IdentityHistory + last-touch attribution. Input identifiers
 * and bounds are already validated/quoted by AnalyticsSQL. CTEs keep latest-touch
 * selection before the finite-horizon filter, and split before learning eligibility.
 */
export function attributionCTEs(table: string, site: string, min: number, from: number, to: number, receivedBefore: number, scope?: AttributionScope, targetExperiment?: string): string[] {
  const before = (a: string, b: string) => `(${a}.occurred_at < ${b}.occurred_at OR (${a}.occurred_at = ${b}.occurred_at AND ${a}.record_id <= ${b}.record_id))`;
  const candidate = `g.record_id AS goal_event_id, g.goal_id, g.value AS goal_value, g.payload_json AS goal_payload,
g.occurred_at, CASE WHEN g.received_at > e.received_at THEN g.received_at ELSE e.received_at END AS received_at,
e.record_id AS exposure_id, e.occurred_at AS exposure_at, e.payload_json AS exposure_payload, e.subject_key, e.cid, g.uid,
e.experiment_id, e.arm_id, e.assignment_id, e.observation_id, g.occurred_at - e.occurred_at AS gap`;
  const scopeCTEs: string[] = [];
  let goalScope = '';
  if (scope) {
    const cids = scope.key === 'cid' ? `SELECT ${scope.value} AS cid`
      : `SELECT cid FROM ac_links WHERE uid = ${scope.value}`;
    scopeCTEs.push(`ac_scope_cids AS (${cids})`);
    const uids = scope.key === 'uid' ? `SELECT ${scope.value} AS uid`
      : `SELECT uid FROM ac_events WHERE cid = ${scope.value} AND json_get_str(payload_json, 'kind') = 'exposure' AND uid IS NOT NULL
UNION SELECT uid FROM ac_links WHERE cid = ${scope.value} AND uid IS NOT NULL`;
    scopeCTEs.push(`ac_scope_uids AS (${uids})`);
    // Conservative identity sets retain every goal that can yield a matching
    // credit, including purchases on another device. Final membership is unchanged.
    goalScope = scope.key === 'uid' && !scope.includeLinked ? ` AND uid = ${scope.value}`
      : ' AND (uid IN (SELECT uid FROM ac_scope_uids) OR cid IN (SELECT cid FROM ac_scope_cids))';
  }
  return [
    `ac_events AS (SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY received_at ASC) AS rn FROM ${table}.events
WHERE site_id = ${site} AND occurred_at >= ${min} AND occurred_at < ${to} AND received_at <= ${receivedBefore} AND status = 'accepted') a WHERE rn = 1)`,
    `ac_links AS (SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY received_at ASC) AS rn FROM ${table}.identity_links
WHERE site_id = ${site} AND occurred_at >= ${min} AND occurred_at < ${to} AND received_at <= ${receivedBefore} AND status IN ('identify','logout')) a WHERE rn = 1)`,
    ...scopeCTEs,
    // Scope goals first, but retain all experiments capable of competing for them.
    `ac_goals AS (SELECT * FROM ac_events WHERE json_get_str(payload_json, 'kind') = 'goal' AND occurred_at >= ${from}${goalScope})`,
    `ac_exposures AS (SELECT * FROM ac_events WHERE json_get_str(payload_json, 'kind') = 'exposure'${scope ? ` AND (
uid IN (SELECT uid FROM ac_goals WHERE uid IS NOT NULL)
OR (uid IS NULL AND (cid IN (SELECT cid FROM ac_goals WHERE uid IS NULL)
OR cid IN (SELECT cid FROM ac_links WHERE uid IN (SELECT uid FROM ac_goals WHERE uid IS NOT NULL)))))` : ''})`,
    // Each direct UID exposure is latest only until its successor in the same
    // experiment. Rank the ownership branches together before testing expiry.
    ...(targetExperiment ? [] : [`ac_uid_exposures AS (SELECT *,
LEAD(occurred_at) OVER (PARTITION BY uid, experiment_id ORDER BY occurred_at, record_id) AS next_exposure_at,
LEAD(record_id) OVER (PARTITION BY uid, experiment_id ORDER BY occurred_at, record_id) AS next_exposure_id
FROM ac_exposures WHERE uid IS NOT NULL)`]),
    ...identityBoundaryCTEs(),
    ...(targetExperiment ? intervalAttributionCTEs(candidate, targetExperiment) : [
      // Disjoint ownership branches expose equality keys to the planner. UNION is
      // equivalent here (goal/exposure IDs are unique) and avoids Basin's known
      // distributed UNION ALL issue. Rank after union, before horizon/eligibility.
      `ac_matches AS (
  SELECT ${candidate} FROM ac_goals g JOIN ac_uid_exposures e ON e.uid = g.uid AND ${before('e', 'g')}
  AND (e.next_exposure_at IS NULL OR g.occurred_at < e.next_exposure_at
  OR (g.occurred_at = e.next_exposure_at AND g.record_id < e.next_exposure_id))
  UNION
  SELECT ${candidate} FROM ac_goals g JOIN ac_after a ON a.next_uid = g.uid
  JOIN ac_exposures e ON e.record_id = a.exposure_key AND ${before('e', 'g')}
  JOIN ac_before b ON b.exposure_key = e.record_id
  WHERE e.uid IS NULL AND COALESCE(b.previous_kind, 'logout') = 'logout' AND a.next_kind = 'identify'
  AND (a.next_at < g.occurred_at OR (a.next_at = g.occurred_at AND a.next_id <= g.record_id))
  UNION
  SELECT ${candidate} FROM ac_goals g JOIN ac_exposures e ON e.cid = g.cid AND ${before('e', 'g')}
  JOIN ac_before b ON b.exposure_key = e.record_id JOIN ac_after a ON a.exposure_key = e.record_id
  WHERE e.uid IS NULL AND g.uid IS NULL AND COALESCE(b.previous_kind, 'logout') = 'logout'
  AND (a.next_id IS NULL OR a.next_at > g.occurred_at OR (a.next_at = g.occurred_at AND a.next_id > g.record_id)))`,
      `ac_candidates AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY goal_event_id, experiment_id
  ORDER BY exposure_at DESC, exposure_id DESC) AS last_touch FROM ac_matches)`,
      `ac_eligible AS (SELECT *, COUNT(*) OVER (PARTITION BY goal_event_id) AS experiment_count FROM ac_candidates
  WHERE last_touch = 1 AND gap <= json_get_int(exposure_payload, 'attributionWindowMs'))`,
    ]),
    `ac_rewards AS (SELECT *, goal_value / experiment_count AS base_value,
POWER(2.0, -1.0 * gap / json_get_int(json_get_json(json_get_json(exposure_payload, 'assignment'), 'settings'), 'attributionHalfLifeMs')) AS decay_factor
FROM ac_eligible)`,
    `credits_latest AS (SELECT 1 AS schema_version, 'credits' AS table_name, ${site} AS site_id,
json_get_json(goal_payload, 'eventId') || ':' || json_get_json(json_get_json(exposure_payload, 'assignment'), 'experimentId') AS record_id,
1 AS revision, occurred_at, received_at, subject_key, cid, uid, experiment_id, arm_id, goal_id, assignment_id, observation_id,
CASE WHEN occurred_at >= json_get_int(exposure_payload, 'startAt') AND occurred_at < json_get_int(exposure_payload, 'endAt') THEN 'eligible' ELSE 'outside_observation' END AS status,
base_value * decay_factor AS value, '{}' AS attributes_json,
'{"goalEventId":' || json_get_json(goal_payload, 'eventId') || ',"experimentCount":' || CAST(experiment_count AS VARCHAR)
|| ',"baseValue":' || CAST(base_value AS VARCHAR) || ',"decayFactor":' || CAST(decay_factor AS VARCHAR)
|| ',"learningClosed":false}' AS payload_json, 1 AS _revision_rank FROM ac_rewards)`,
  ];
}

/** Precompute identity boundaries outside correlated subqueries for Basin. */
export function identitySegments(links: string, alias: string): string {
  return `${alias} AS (SELECT cid, uid, status, occurred_at, record_id,
LAG(status) OVER (PARTITION BY cid ORDER BY occurred_at, record_id) AS previous_kind,
LAG(occurred_at) OVER (PARTITION BY cid ORDER BY occurred_at, record_id) AS previous_at,
LAG(record_id) OVER (PARTITION BY cid ORDER BY occurred_at, record_id) AS previous_id
FROM ${links})`;
}

/** Claim only the anonymous interval immediately before its first login. */
export function anonymousMatch(record: string, uid: string, link: string, bound: string): string {
  return `(${record}.uid IS NULL AND ${link}.status = 'identify' AND ${link}.uid = ${uid} AND ${link}.cid = ${record}.cid
AND (${record}.occurred_at < ${link}.occurred_at OR (${record}.occurred_at = ${link}.occurred_at AND ${record}.record_id < ${link}.record_id))
AND ${link}.occurred_at <= ${bound} AND (${link}.previous_kind IS NULL OR (${link}.previous_kind = 'logout'
AND (${record}.occurred_at > ${link}.previous_at OR (${record}.occurred_at = ${link}.previous_at AND ${record}.record_id > ${link}.previous_id)))))`;
}

export function anonymousLink(record: string, uid: string, segments: string, bound: string): string {
  return `EXISTS (SELECT 1 FROM ${segments} l WHERE ${anonymousMatch(record, uid, 'l', bound)})`;
}
