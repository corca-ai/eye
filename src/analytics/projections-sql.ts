import { analyticsRecord } from './records.js';

const columns = Object.keys(analyticsRecord({ siteId: '', subjectKey: '' }, 'events', '', 1, 0, 0, {}));
/** Reconstruct pending samples and selected assignments from durable exposures.
 * Keep physical rows for closed learning results and rolling upgrades. No
 * first-receipt marker or per-user ledger is needed: any retained receipt works.
 * All SQL identifiers/values are supplied by the validated query builder.
 */
export function exposureProjection(table: 'observations' | 'decisions', alias: string, namespace: string,
  site: string, retained: number, from: number, to: number, receivedBefore: number, extra: string): string {
  const observation = table === 'observations';
  const key = observation ? 'observation_id' : 'assignment_id';
  const assignment = "json_get_json(payload_json, 'assignment')";
  const json = (key: string) => `json_get_json(payload_json, '${key}')`;
  const object = (fields: Record<string, string>) => `'{' || ${Object.entries(fields).map(([key, value], i) => `'${i ? ',' : ''}"${key}":' || ${value}`).join(' || ')} || '}'`;
  const payload = observation ? object({
    observationId: json('sampleId'), assignmentId: `json_get_json(${assignment}, 'assignmentId')`,
    subjectKey: "json_get_json(payload_json, 'projectionSubjectKey')", subject: json('subject'),
    experimentId: `json_get_json(${assignment}, 'experimentId')`, armId: `json_get_json(${assignment}, 'armId')`,
    generation: `json_get_json(${assignment}, 'generation')`, startAt: json('startAt'), endAt: json('endAt'),
    closeAt: json('closeAt'), assignment, status: `'"pending"'`, reward: "'0'",
  }) : object({ assignment, reason: `'"selected"'`, probability: `json_get_json(${assignment}, 'probability')`, generation: `json_get_json(${assignment}, 'generation')` });
  const overrides: Record<string, string> = {
    table_name: `'${table}'`, record_id: key, revision: '1',
    occurred_at: observation ? "json_get_int(payload_json, 'startAt')" : `json_get_int(${assignment}, 'assignedAt')`,
    status: observation ? "'pending'" : "'selected'", value: observation ? '0' : 'NULL',
    attributes_json: observation ? "COALESCE(json_get_json(payload_json, 'userAttributes'), '{}')" : "'{}'",
    payload_json: payload,
  };
  // subject_key is JSON-encoded at ingestion because Basin has no portable
  // scalar-to-JSON quoting function. Legacy rows supply their original payload.
  return `${alias}_receipts AS (SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY ${key} ORDER BY occurred_at, record_id, received_at) AS receipt_rank
FROM ${namespace}.events WHERE site_id = ${site} AND occurred_at >= ${retained} AND occurred_at < ${receivedBefore + 1}
AND received_at <= ${receivedBefore} AND status = 'accepted' AND json_get_str(payload_json, 'kind') = 'exposure'
AND json_get_json(payload_json, 'projectionSubjectKey') IS NOT NULL) r WHERE receipt_rank = 1),
${alias}_derived AS (SELECT ${columns.map(column => `${overrides[column] ?? column} AS ${column}`).join(', ')} FROM ${alias}_receipts),
${alias}_sources AS (SELECT ${columns.join(', ')}, 1 AS source_priority FROM ${alias}_derived WHERE occurred_at >= ${from} AND occurred_at < ${to}${extra}
UNION ALL SELECT ${columns.join(', ')}, 0 AS source_priority FROM ${namespace}.${table} WHERE site_id = ${site} AND occurred_at >= ${from} AND occurred_at < ${to} AND received_at <= ${receivedBefore}${extra}),
${alias} AS (SELECT ${columns.join(', ')}, _revision_rank FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY revision DESC, received_at ASC, source_priority DESC) AS _revision_rank FROM ${alias}_sources) r WHERE _revision_rank = 1)`;
}
