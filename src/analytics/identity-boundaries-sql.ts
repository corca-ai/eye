/** Ignore no-op anonymous checks, retaining real logout boundaries. Shared by attribution and linked timelines. */
export function normalizedIdentityCTEs(source: string, alias: string): string[] {
  return [
    `${alias}_ordered AS (SELECT *, LAG(status) OVER (PARTITION BY cid ORDER BY occurred_at,record_id) AS previous_status FROM ${source})`,
    `${alias} AS (SELECT cid,uid,occurred_at,record_id, CASE WHEN status='anonymous' THEN 'logout' ELSE status END AS status
FROM ${alias}_ordered WHERE status IN ('identify','logout') OR (status='anonymous' AND previous_status='identify'))`,
  ];
}

/** Number identity boundaries on a merged event-time stream. The link at the
 * same position precedes an exposure, matching the attribution <= boundary. */
export function identityBoundaryCTEs(): string[] {
  return [
    `ac_identity_stream AS (
SELECT cid, occurred_at, record_id, 1 AS boundary, status, uid FROM ac_links
UNION SELECT cid, occurred_at, record_id, 0 AS boundary, NULL AS status, NULL AS uid FROM ac_exposures)`,
    `ac_identity_numbered AS (SELECT *, SUM(boundary) OVER (PARTITION BY cid
ORDER BY occurred_at, record_id, boundary DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS boundary_index
FROM ac_identity_stream)`,
    `ac_boundaries AS (SELECT * FROM ac_identity_numbered WHERE boundary = 1)`,
    `ac_before AS (SELECT e.record_id AS exposure_key, p.status AS previous_kind
FROM ac_identity_numbered e LEFT JOIN ac_boundaries p ON p.cid = e.cid AND p.boundary_index = e.boundary_index WHERE e.boundary = 0)`,
    `ac_after AS (SELECT e.record_id AS exposure_key, a.status AS next_kind, a.uid AS next_uid,
a.occurred_at AS next_at, a.record_id AS next_id
FROM ac_identity_numbered e LEFT JOIN ac_boundaries a ON a.cid = e.cid AND a.boundary_index = e.boundary_index + 1 WHERE e.boundary = 0)`,
  ];
}
