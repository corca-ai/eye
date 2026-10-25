/** Existence is decided by the first matching track at/after a probe. Prefix
 * track counts turn that lookup into an equality join, not all matching pairs.
 * A probe precedes a track at the same position, preserving inclusive starts. */
export function hasEventCTEs(name: string, filter: string): string[] {
  return [
    `first_exposures AS (SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY observation_id ORDER BY occurred_at, record_id) AS first_position FROM ac_exposures) ranked WHERE first_position = 1)`,
    // Establish one observation row before branching into owner probes. Besides
    // preserving the relation's key, DISTINCT avoids repeated expansion of the
    // projection/boundary joins in the local query planner.
    `he_observations AS (SELECT DISTINCT o.observation_id, o.occurred_at AS observation_start,
json_get_int(o.payload_json, 'endAt') AS end_at, x.occurred_at AS exposure_at, x.record_id AS exposure_id,
x.cid, x.uid, b.previous_kind, a.next_kind, a.next_uid, a.next_at, a.next_id
FROM observations_latest o JOIN first_exposures x ON x.observation_id = o.observation_id
JOIN ac_before b ON b.exposure_key = x.record_id JOIN ac_after a ON a.exposure_key = x.record_id)`,
    `he_probes AS (
SELECT observation_id, 'uid' AS owner_kind, uid AS owner_id, observation_start, end_at,
CASE WHEN observation_start > exposure_at THEN observation_start ELSE exposure_at END AS start_at,
CASE WHEN observation_start > exposure_at THEN '' ELSE exposure_id END AS start_id,
NULL AS stop_at, NULL AS stop_id FROM he_observations WHERE uid IS NOT NULL
UNION SELECT observation_id, 'cid' AS owner_kind, cid AS owner_id, observation_start, end_at,
CASE WHEN observation_start > exposure_at THEN observation_start ELSE exposure_at END AS start_at,
CASE WHEN observation_start > exposure_at THEN '' ELSE exposure_id END AS start_id,
next_at AS stop_at, next_id AS stop_id FROM he_observations
WHERE uid IS NULL AND COALESCE(previous_kind, 'logout') = 'logout'
UNION SELECT observation_id, 'uid' AS owner_kind, next_uid AS owner_id, observation_start, end_at,
CASE WHEN observation_start > next_at THEN observation_start ELSE next_at END AS start_at,
CASE WHEN observation_start > next_at THEN '' ELSE next_id END AS start_id,
NULL AS stop_at, NULL AS stop_id FROM he_observations
WHERE uid IS NULL AND COALESCE(previous_kind, 'logout') = 'logout' AND next_kind = 'identify')`,
    `he_stream AS (
SELECT CASE WHEN e.uid IS NULL THEN 'cid' ELSE 'uid' END AS owner_kind, COALESCE(e.uid,e.cid) AS owner_id,
e.occurred_at, e.record_id, 1 AS is_track, NULL AS observation_id FROM events_latest e
WHERE json_get_str(e.payload_json, 'kind') = 'track' AND json_get_str(e.payload_json, 'name') = ${name}${filter}
UNION SELECT owner_kind, owner_id, start_at AS occurred_at, start_id AS record_id, 0 AS is_track, observation_id FROM he_probes)`,
    `he_numbered AS (SELECT *, SUM(is_track) OVER (PARTITION BY owner_kind, owner_id
ORDER BY occurred_at, record_id, is_track ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS track_index FROM he_stream)`,
    `he_tracks AS (SELECT * FROM he_numbered WHERE is_track = 1)`,
    `matching_event_observations AS (SELECT DISTINCT p.observation_id FROM he_numbered p
JOIN he_tracks t ON t.owner_kind = p.owner_kind AND t.owner_id = p.owner_id AND t.track_index = p.track_index + 1
JOIN he_probes b ON b.observation_id = p.observation_id AND b.owner_kind = p.owner_kind AND b.owner_id = p.owner_id
WHERE p.is_track = 0 AND t.occurred_at >= b.observation_start AND t.occurred_at < b.end_at
AND (b.stop_id IS NULL OR t.occurred_at < b.stop_at OR (t.occurred_at = b.stop_at AND t.record_id < b.stop_id)))`,
  ];
}
