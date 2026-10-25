import { anonymousExposureSQL } from './ownership-sql.js';
/** Canonical latest-touch intervals and their overlap count. Anonymous claims
 * activate at login but keep their original exposure rank: a late claim must
 * never displace a newer direct touch or revive an expired older touch. */
export function intervalAttributionCTEs(candidate: string, experiment: string): string[] {
  const cidStop = `s.owner_kind = 'cid' AND a.next_id IS NOT NULL AND (s.next_start_at IS NULL
OR a.next_at < s.next_start_at OR (a.next_at = s.next_start_at AND a.next_id < s.next_start_id))`;
  return [
    `ac_exposure_ordered AS (SELECT e.*, ROW_NUMBER() OVER (ORDER BY occurred_at, record_id) AS exposure_order FROM ac_exposures e)`,
    `ac_activations AS (
SELECT 'uid' AS owner_kind, e.uid AS owner_id, e.experiment_id, e.occurred_at AS start_at, e.record_id AS start_id, e.exposure_order
FROM ac_exposure_ordered e WHERE e.uid IS NOT NULL
UNION SELECT 'cid' AS owner_kind, e.cid AS owner_id, e.experiment_id, e.occurred_at AS start_at, e.record_id AS start_id, e.exposure_order
FROM ac_exposure_ordered e JOIN ac_before b ON b.exposure_key = e.record_id
WHERE ${anonymousExposureSQL('e.uid', 'b.previous_kind')}
UNION SELECT 'uid' AS owner_kind, a.next_uid AS owner_id, e.experiment_id, a.next_at AS start_at, a.next_id AS start_id, e.exposure_order
FROM ac_exposure_ordered e JOIN ac_before b ON b.exposure_key = e.record_id JOIN ac_after a ON a.exposure_key = e.record_id
WHERE ${anonymousExposureSQL('e.uid', 'b.previous_kind')} AND a.next_kind = 'identify')`,
    `ac_activation_points AS (SELECT owner_kind, owner_id, experiment_id, start_at, start_id, MAX(exposure_order) AS exposure_order
FROM ac_activations GROUP BY owner_kind, owner_id, experiment_id, start_at, start_id)`,
    `ac_activation_max AS (SELECT *, MAX(exposure_order) OVER (PARTITION BY owner_kind, owner_id, experiment_id
ORDER BY start_at, start_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS selected_exposure FROM ac_activation_points)`,
    `ac_change_positions AS (SELECT *, LAG(selected_exposure) OVER (PARTITION BY owner_kind, owner_id, experiment_id ORDER BY start_at, start_id) AS previous_exposure
FROM ac_activation_max)`,
    `ac_changes AS (SELECT * FROM ac_change_positions WHERE previous_exposure IS NULL OR selected_exposure > previous_exposure)`,
    `ac_successors AS (SELECT *,
LEAD(start_at) OVER (PARTITION BY owner_kind, owner_id, experiment_id ORDER BY start_at, start_id) AS next_start_at,
LEAD(start_id) OVER (PARTITION BY owner_kind, owner_id, experiment_id ORDER BY start_at, start_id) AS next_start_id FROM ac_changes)`,
    // Stop latest-touch ownership before clipping to the horizon. Empty/expired
    // new selections still terminate the previous selection, preventing fallback.
    `ac_raw_intervals AS (SELECT s.*, e.occurred_at + json_get_int(e.payload_json, 'attributionWindowMs') AS expiry_at,
CASE WHEN ${cidStop} THEN a.next_at ELSE s.next_start_at END AS stop_at,
CASE WHEN ${cidStop} THEN a.next_id ELSE s.next_start_id END AS stop_id
FROM ac_successors s JOIN ac_exposure_ordered e ON e.exposure_order = s.selected_exposure
JOIN ac_after a ON a.exposure_key = e.record_id)`,
    // Phase 2 is after every real event ID at the expiry timestamp: the existing
    // horizon uses gap <= horizon, whereas touch/identity boundaries are exclusive.
    `ac_interval_ends AS (SELECT *, CASE WHEN stop_at IS NOT NULL AND stop_at <= expiry_at THEN stop_at ELSE expiry_at END AS end_at,
CASE WHEN stop_at IS NOT NULL AND stop_at <= expiry_at THEN 1 ELSE 2 END AS end_phase,
CASE WHEN stop_at IS NOT NULL AND stop_at <= expiry_at THEN stop_id ELSE '' END AS end_id FROM ac_raw_intervals)`,
    `ac_intervals AS (SELECT * FROM ac_interval_ends WHERE start_at < end_at OR (start_at = end_at AND (end_phase = 2 OR start_id < end_id)))`,
    // Keep the interval key through UNION so simultaneous endpoints belonging
    // to different intervals cannot be deduplicated before their deltas are summed.
    `ac_delta_edges AS (
SELECT owner_kind, owner_id, experiment_id, start_at AS interval_at, start_id AS interval_id,
start_at AS at, 1 AS phase, start_id AS point_id, 1 AS delta FROM ac_intervals
UNION SELECT owner_kind, owner_id, experiment_id, start_at AS interval_at, start_id AS interval_id,
end_at AS at, end_phase AS phase, end_id AS point_id, -1 AS delta FROM ac_intervals)`,
    `ac_deltas AS (SELECT owner_kind, owner_id, at, phase, point_id, SUM(delta) AS delta FROM ac_delta_edges GROUP BY owner_kind, owner_id, at, phase, point_id)`,
    `ac_goal_stream AS (
SELECT owner_kind, owner_id, at, phase, point_id, delta, 0 AS is_goal, NULL AS goal_event_id FROM ac_deltas
UNION SELECT CASE WHEN uid IS NULL THEN 'cid' ELSE 'uid' END AS owner_kind, COALESCE(uid,cid) AS owner_id,
occurred_at AS at, 1 AS phase, record_id AS point_id, 0 AS delta, 1 AS is_goal, record_id AS goal_event_id FROM ac_goals)`,
    `ac_counted AS (SELECT *, SUM(delta) OVER (PARTITION BY owner_kind, owner_id
ORDER BY at, phase, point_id, is_goal ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS experiment_count FROM ac_goal_stream)`,
    `ac_goal_counts AS (SELECT goal_event_id, experiment_count FROM ac_counted WHERE is_goal = 1)`,
    `ac_target_matches AS (SELECT ${candidate}, c.experiment_count FROM ac_goals g
JOIN ac_goal_counts c ON c.goal_event_id = g.record_id
JOIN ac_intervals i ON i.owner_kind = CASE WHEN g.uid IS NULL THEN 'cid' ELSE 'uid' END AND i.owner_id = COALESCE(g.uid,g.cid)
AND i.experiment_id = ${experiment}
AND (g.occurred_at > i.start_at OR (g.occurred_at = i.start_at AND g.record_id >= i.start_id))
AND (g.occurred_at < i.end_at OR (g.occurred_at = i.end_at AND (i.end_phase = 2 OR g.record_id < i.end_id)))
JOIN ac_exposure_ordered e ON e.exposure_order = i.selected_exposure)`,
    `ac_eligible AS (SELECT * FROM ac_target_matches)`,
  ];
}
