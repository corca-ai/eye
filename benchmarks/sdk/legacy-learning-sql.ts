// Historical SQL learner retained for comparative benchmarks only.
import { attributionCTEs } from '../../src/analytics/attribution-sql.js';
import { literal } from '../../src/analytics/sql.js';
import { invariant } from '../../src/core/errors.js';
import { RETENTION_MS } from '../../src/core/validation.js';

/** One closing interval is computed in storage. Selection only limits result
 * samples: all simultaneous experiments remain in the last-touch denominator.
 * Cursor partitions are a bounded overflow path, not operator result pagination.
 */
export function closingSQL(namespace: string, siteId: string, from: number, until: number, after: string,
  limit: number, visibleAt: number, bounds: { windowMs: number; graceMs: number; attributionMs: number }): string {
  invariant(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(namespace), 'invalid_input', 'Invalid namespace');
  invariant(Number.isSafeInteger(limit) && limit > 0 && limit <= 9999, 'invalid_input', 'Invalid closing result limit');
  const retained = Math.max(0, visibleAt - RETENTION_MS);
  const observationMin = Math.max(retained, from - bounds.windowMs - bounds.graceMs);
  const rawMin = Math.max(retained, observationMin - bounds.attributionMs);
  const ctes = attributionCTEs(`"${namespace}"`, literal(siteId), retained, observationMin, until, visibleAt, rawMin).slice(0, -1);
  // Identity history retains the full horizon. Event candidates need only cover
  // target observation windows plus the longest possible competing last touch.
  ctes.push(`cc_targets AS (SELECT * FROM (
SELECT payload_json, observation_id, ROW_NUMBER() OVER (PARTITION BY observation_id ORDER BY occurred_at, record_id) AS first_exposure
FROM ac_exposures WHERE json_get_int(payload_json, 'closeAt') >= ${from} AND json_get_int(payload_json, 'closeAt') < ${until}
AND observation_id > ${literal(after)}) c WHERE first_exposure = 1 ORDER BY observation_id LIMIT ${limit})`);
  // Repeated receipts must describe one immutable sample, even when a later
  // receipt has a different closeAt and would not itself be a target row.
  ctes.push(`cc_contexts AS (SELECT e.observation_id,
CASE WHEN MIN(json_get_json(e.payload_json, 'assignment')) = MAX(json_get_json(e.payload_json, 'assignment'))
AND MIN(json_get_int(e.payload_json, 'startAt')) = MAX(json_get_int(e.payload_json, 'startAt'))
AND MIN(json_get_int(e.payload_json, 'attributionWindowMs')) = MAX(json_get_int(e.payload_json, 'attributionWindowMs'))
THEN 0 ELSE 1 END AS context_conflict
FROM ac_exposures e JOIN cc_targets t ON e.observation_id = t.observation_id GROUP BY e.observation_id)`);
  ctes.push(`cc_values AS (SELECT observation_id, base_value * decay_factor AS reward FROM ac_rewards
WHERE occurred_at >= json_get_int(exposure_payload, 'startAt') AND occurred_at < json_get_int(exposure_payload, 'endAt')
AND observation_id IN (SELECT observation_id FROM cc_targets))`);
  // Scale before summation so cancelling large finite values do not overflow an
  // intermediate SUM. Like the rest of the engine this is floating point.
  ctes.push(`cc_scales AS (SELECT observation_id, MAX(ABS(reward)) AS scale FROM cc_values GROUP BY observation_id)`);
  ctes.push(`cc_totals AS (SELECT v.observation_id, SUM(v.reward / NULLIF(s.scale, 0)) * MAX(s.scale) AS reward
FROM cc_values v JOIN cc_scales s ON v.observation_id = s.observation_id GROUP BY v.observation_id)`);
  return `WITH ${ctes.join(',\n')} SELECT t.observation_id, t.payload_json, c.context_conflict, COALESCE(r.reward, 0) AS reward
FROM cc_targets t JOIN cc_contexts c ON t.observation_id = c.observation_id LEFT JOIN cc_totals r ON t.observation_id = r.observation_id ORDER BY t.observation_id LIMIT ${limit}`;
}
