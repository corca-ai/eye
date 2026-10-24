import { DatabaseSync } from 'node:sqlite';
import { analyticsRecord, type AnalyticsRecord } from '../../src/analytics/records.js';
import { TABLES } from '../../src/analytics/sql.js';
export function database(records: AnalyticsRecord[]) {
  const db = new DatabaseSync(':memory:');
  db.exec("ATTACH DATABASE ':memory:' AS eye");
  const example = analyticsRecord({ siteId: 'site', subjectKey: 'subject', cid: 'browser' }, 'events', 'example', 1, 0, 0, {});
  for (const table of TABLES) {
    db.exec(`CREATE TABLE eye.${table} (${Object.keys(example).map(key => `"${key}" ${['schema_version', 'revision', 'occurred_at', 'received_at', 'value'].includes(key) ? 'REAL' : 'TEXT'}`).join(',')})`);
  }
  for (const record of records) db.prepare(`INSERT INTO eye.${record.table_name} VALUES (${Object.keys(example).map(() => '?').join(',')})`).run(...Object.values(record));
  for (const [name, kind] of [['json_get_str', 'string'], ['json_get_float', 'number'], ['json_get_int', 'number'], ['json_get_bool', 'boolean'], ['json_get_json', 'json'], ['json_contains', 'exists']] as const) {
    db.function(name, (json, key) => {
      const obj: Record<string, unknown> = JSON.parse(String(json)), value = obj[String(key)];
      if (kind === 'exists') return Object.hasOwn(obj, String(key)) ? 1 : 0;
      if (kind === 'json') return value === undefined ? null : JSON.stringify(value);
      return typeof value !== kind ? null : typeof value === 'boolean' ? Number(value) : String(value) === 'undefined' ? null : typeof value === 'number' || typeof value === 'string' ? value : null;
    });
  }
  const run = (query: string) => db.prepare(query).all().map(r => ({ ...r }));
  const request: typeof fetch = async (_url, init) => {
    const body: { query: string } = JSON.parse(String(init?.body));
    return Response.json({ success: true, result: { rows: run(body.query), metrics: { bytes_scanned: 128 } } });
  };
  return { run, request, close: () => db.close() };
}
