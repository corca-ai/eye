/** SQL counterpart of IdentityHistory + last-touch attribution. Input identifiers
 * and bounds are already validated/quoted by AnalyticsSQL. CTEs keep latest-touch
 * selection before the finite-horizon filter, and split before learning eligibility.
 */
export function attributionCTEs(table: string, site: string, min: number, from: number, to: number, receivedBefore: number, eventMin = min): string[] {
  const before = (a: string, b: string) => `(${a}.occurred_at < ${b}.occurred_at OR (${a}.occurred_at = ${b}.occurred_at AND ${a}.record_id <= ${b}.record_id))`;
  return [
    `ac_events AS (SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY received_at ASC) AS rn FROM ${table}.events
WHERE site_id = ${site} AND occurred_at >= ${eventMin} AND occurred_at < ${to} AND received_at <= ${receivedBefore} AND status = 'accepted') a WHERE rn = 1)`,
    `ac_links AS (SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY received_at ASC) AS rn FROM ${table}.identity_links
WHERE site_id = ${site} AND occurred_at >= ${min} AND occurred_at < ${to} AND received_at <= ${receivedBefore} AND status IN ('identify','logout')) a WHERE rn = 1)`,
    `ac_exposures AS (SELECT * FROM ac_events WHERE json_get_str(payload_json, 'kind') = 'exposure')`,
    `ac_before AS (SELECT * FROM (SELECT e.record_id AS exposure_key, l.status AS previous_kind,
ROW_NUMBER() OVER (PARTITION BY e.record_id ORDER BY l.occurred_at DESC, l.record_id DESC) AS position
FROM ac_exposures e LEFT JOIN ac_links l ON l.cid = e.cid AND ${before('l', 'e')}) a WHERE position = 1)`,
    `ac_after AS (SELECT * FROM (SELECT e.record_id AS exposure_key, l.status AS next_kind, l.uid AS next_uid, l.occurred_at AS next_at, l.record_id AS next_id,
ROW_NUMBER() OVER (PARTITION BY e.record_id ORDER BY CASE WHEN l.record_id IS NULL THEN 1 ELSE 0 END, l.occurred_at, l.record_id) AS position
FROM ac_exposures e LEFT JOIN ac_links l ON l.cid = e.cid AND NOT ${before('l', 'e')}) a WHERE position = 1)`,
    `ac_candidates AS (SELECT g.record_id AS goal_event_id, g.goal_id, g.value AS goal_value, g.payload_json AS goal_payload,
g.occurred_at, CASE WHEN g.received_at > e.received_at THEN g.received_at ELSE e.received_at END AS received_at,
e.record_id AS exposure_id, e.payload_json AS exposure_payload, e.subject_key, e.state_key, e.cid, g.uid,
e.experiment_id, e.arm_id, e.assignment_id, e.observation_id, g.occurred_at - e.occurred_at AS gap,
ROW_NUMBER() OVER (PARTITION BY g.record_id, e.experiment_id ORDER BY e.occurred_at DESC, e.record_id DESC) AS last_touch
FROM ac_events g JOIN ac_exposures e ON ${before('e', 'g')}
JOIN ac_before b ON b.exposure_key = e.record_id JOIN ac_after a ON a.exposure_key = e.record_id
WHERE json_get_str(g.payload_json, 'kind') = 'goal' AND g.occurred_at >= ${from}
AND ((e.uid IS NOT NULL AND e.uid = g.uid) OR (e.uid IS NULL AND COALESCE(b.previous_kind, 'logout') = 'logout' AND (
(g.uid IS NOT NULL AND a.next_kind = 'identify' AND a.next_uid = g.uid AND (a.next_at < g.occurred_at OR (a.next_at = g.occurred_at AND a.next_id <= g.record_id)))
OR (g.uid IS NULL AND e.cid = g.cid AND (a.next_id IS NULL OR a.next_at > g.occurred_at OR (a.next_at = g.occurred_at AND a.next_id > g.record_id)))))))`,
    `ac_eligible AS (SELECT *, COUNT(*) OVER (PARTITION BY goal_event_id) AS experiment_count FROM ac_candidates
WHERE last_touch = 1 AND gap <= json_get_int(exposure_payload, 'attributionWindowMs'))`,
    `ac_rewards AS (SELECT *, goal_value / experiment_count AS base_value,
POWER(2.0, -1.0 * gap / json_get_int(json_get_json(json_get_json(exposure_payload, 'assignment'), 'settings'), 'attributionHalfLifeMs')) AS decay_factor
FROM ac_eligible)`,
    `credits_latest AS (SELECT 1 AS schema_version, 'credits' AS table_name, ${site} AS site_id,
json_get_json(goal_payload, 'eventId') || ':' || json_get_json(json_get_json(exposure_payload, 'assignment'), 'experimentId') AS record_id,
1 AS revision, occurred_at, received_at, subject_key, state_key, cid, uid, experiment_id, arm_id, goal_id, assignment_id, observation_id,
CASE WHEN occurred_at >= json_get_int(exposure_payload, 'startAt') AND occurred_at < json_get_int(exposure_payload, 'endAt') THEN 'eligible' ELSE 'outside_observation' END AS status,
base_value * decay_factor AS value, '{}' AS attributes_json,
'{"goalEventId":' || json_get_json(goal_payload, 'eventId') || ',"experimentCount":' || CAST(experiment_count AS VARCHAR)
|| ',"baseValue":' || CAST(base_value AS VARCHAR) || ',"decayFactor":' || CAST(decay_factor AS VARCHAR)
|| ',"learningClosed":false}' AS payload_json, 1 AS _revision_rank FROM ac_rewards)`,
  ];
}

/** Claim only the anonymous interval immediately before its first login. */
export function anonymousLink(record: string, uid: string, links: string, bound: string): string {
  const before = (a: string, b: string) => `(${a}.occurred_at < ${b}.occurred_at OR (${a}.occurred_at = ${b}.occurred_at AND ${a}.record_id <= ${b}.record_id))`;
  return `(${record}.uid IS NULL AND EXISTS (SELECT 1 FROM ${links} l WHERE l.status = 'identify' AND l.uid = ${uid} AND l.cid = ${record}.cid
AND ${before(record, 'l')} AND l.occurred_at <= ${bound}
AND NOT EXISTS (SELECT 1 FROM ${links} p WHERE p.cid = l.cid AND ${before(record, 'p')} AND NOT ${before('l', 'p')})
AND NOT EXISTS (SELECT 1 FROM ${links} p WHERE p.cid = l.cid AND p.status = 'identify' AND ${before('p', record)}
AND NOT EXISTS (SELECT 1 FROM ${links} x WHERE x.cid = p.cid AND x.status = 'logout' AND ${before('p', 'x')} AND ${before('x', record)}))))`;
}
