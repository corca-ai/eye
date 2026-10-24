import { BasinAnalytics, type AnalyticsEnv } from '../analytics/query.js';
import { analyticsRecord, type AnalyticsRecord } from '../analytics/records.js';
import { literal } from '../analytics/sql.js';
import { reduceClosedCohort, type CohortInput, type ClosedCohort } from '../core/closed-cohort.js';
import { parseEvent } from '../core/events.js';
import { invariant } from '../core/errors.js';
import { RETENTION_MS, subjectKey } from '../core/validation.js';
import type { EyeEvent } from '../core/types.js';

export const COHORT_INTERVAL_MS = 3_600_000;
export const COHORT_PAGE_SIZE = 50;
export interface LearningPage { cohort: ClosedCohort; records: AnalyticsRecord[]; next: string | null }
/** Date pruning plus candidate identity semi-joins; no unbounded raw download or
 * OFFSET pagination. Large partitions fail visibly and can retry with fewer samples.
 */
export class LearningSource {
  private sql?: BasinAnalytics;
  private readonly table: string;
  constructor(private readonly env: AnalyticsEnv, private readonly siteId: string, private readonly bounds = { windowMs: RETENTION_MS, graceMs: 0, attributionMs: RETENTION_MS }, private readonly request: typeof fetch = fetch.bind(globalThis), private readonly clock: () => number = Date.now) {
    const namespace = env.EYE_ANALYTICS_NAMESPACE ?? 'eye';
    invariant(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(namespace), 'invalid_input', 'Invalid namespace');
    this.table = `"${namespace}"`;
  }
  async page(from: number, until: number, after: string, limit = COHORT_PAGE_SIZE): Promise<LearningPage> {
    const sql = this.sql ??= new BasinAnalytics(this.env, this.siteId, this.request, this.clock);
    const visibleAt = this.clock(), min = Math.max(0, visibleAt - RETENTION_MS);
    const common = `site_id = ${literal(this.siteId)} AND occurred_at >= ${min} AND occurred_at <= ${visibleAt} AND received_at <= ${visibleAt}`;
    const observationMin = Math.max(min, from - this.bounds.windowMs - this.bounds.graceMs);
    const targets = await sql.learningQuery(`SELECT sample_id AS record_id, cid, uid, payload_json FROM (
SELECT *, json_get_str(payload_json, 'sampleId') AS sample_id, ROW_NUMBER() OVER (PARTITION BY json_get_str(payload_json, 'sampleId') ORDER BY occurred_at ASC, record_id ASC) AS rn
FROM ${this.table}.events WHERE ${common} AND occurred_at >= ${observationMin} AND json_get_str(payload_json, 'sampleId') > ${literal(after)}
AND json_get_int(payload_json, 'closeAt') >= ${from} AND json_get_int(payload_json, 'closeAt') < ${until}
) t WHERE rn = 1 ORDER BY sample_id LIMIT ${limit}`, limit);
    const cohortId = JSON.stringify([this.siteId, from, until, after]);
    if (targets.length === 0) return { cohort: { cohortId, asOf: until, samples: [], arms: [], credits: [] }, records: [], next: null };
    const windows = targets.map(t => JSON.parse(String(t.payload_json)) as { startAt: number; endAt: number });
    invariant(windows.every(w => Number.isSafeInteger(w.startAt) && Number.isSafeInteger(w.endAt)), 'unavailable', 'Invalid observation interval');
    const rawMin = Math.max(min, Math.min(...windows.map(w => w.startAt)) - this.bounds.attributionMs);
    const rawMax = Math.max(...windows.map(w => w.endAt));
    const cids = targets.map(t => t.cid).filter((v): v is string => typeof v === 'string');
    const uids = targets.map(t => t.uid).filter((v): v is string => typeof v === 'string');
    const values = (list: string[]) => list.length ? [...new Set(list)].map(literal).join(',') : 'NULL';
    const rows = await sql.learningQuery(`WITH links AS (
 SELECT * FROM ${this.table}.identity_links WHERE ${common}
), owners AS (
 SELECT uid FROM links WHERE cid IN (${values(cids)})
 UNION SELECT uid FROM links WHERE uid IN (${values(uids)})
), browsers AS (
 SELECT cid FROM links WHERE uid IN (SELECT uid FROM owners) OR uid IN (${values(uids)})
), raw AS (
 SELECT payload_json, status, occurred_at, record_id, ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY received_at ASC) AS rn
 FROM ${this.table}.events WHERE site_id = ${literal(this.siteId)} AND occurred_at >= ${rawMin} AND occurred_at <= ${rawMax} AND received_at <= ${visibleAt}
 AND (cid IN (${values(cids)}) OR uid IN (${values(uids)}) OR uid IN (SELECT uid FROM owners) OR cid IN (SELECT cid FROM browsers))
 AND json_get_str(payload_json, 'kind') IN ('exposure', 'goal')
), identity_raw AS (
 SELECT payload_json, 'accepted' AS status, occurred_at, record_id, ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY received_at ASC) AS rn
 FROM links WHERE cid IN (${values(cids)}) OR cid IN (SELECT cid FROM browsers)
), combined AS (
 SELECT * FROM raw UNION ALL SELECT * FROM identity_raw
)
SELECT payload_json, status FROM combined WHERE rn = 1 ORDER BY occurred_at, record_id LIMIT 10001`, 10000);
    const events = rows.filter(row => row.status === 'accepted').map(row => {
      invariant(typeof row.payload_json === 'string', 'unavailable', 'Invalid raw event');
      return parseEvent(JSON.parse(row.payload_json));
    });
    return reduceLearningPage(this.siteId, cohortId, from, until, targets.map(t => String(t.record_id)), events,
      targets.length < limit ? null : String(targets.at(-1)!.record_id), visibleAt);
  }
}

export function reduceLearningPage(siteId: string, cohortId: string, from: number, until: number, sampleIds: string[], events: readonly EyeEvent[], next: string | null, receivedAt: number): LearningPage {
  const input: CohortInput = { cohortId, from, until, asOf: until, sampleIds,
    exposures: events.filter(e => e.kind === 'exposure' && e.sample && e.attributionWindowMs).map(event => {
      invariant(event.kind === 'exposure' && event.sample && event.attributionWindowMs, 'invalid_input', 'Missing sample');
      return { event, sampleId: event.sample.sampleId, startAt: event.sample.startAt, attributionWindowMs: event.attributionWindowMs };
    }), goals: events.filter(e => e.kind === 'goal'), identities: events.filter((e): e is import('../core/types.js').IdentityEvent => e.kind === 'identify' || e.kind === 'logout') };
  const cohort = reduceClosedCohort(input), records: AnalyticsRecord[] = [];
  for (const sample of cohort.samples) {
    const first = input.exposures.find(e => e.sampleId === sample.sampleId)!;
    const context = { siteId, subjectKey: subjectKey(siteId, first.event.subject), ...first.event.subject };
    records.push(analyticsRecord(context, 'observations', sample.sampleId, 2, sample.startAt, receivedAt,
      { ...sample, observationId: sample.sampleId, assignmentId: sample.assignment.assignmentId,
        experimentId: sample.assignment.experimentId, armId: sample.assignment.armId, generation: sample.assignment.generation,
        closeAt: sample.endAt + sample.assignment.settings.allowedLatenessMs, status: 'complete', learningClosed: true },
      { experiment_id: sample.assignment.experimentId, arm_id: sample.assignment.armId, assignment_id: sample.assignment.assignmentId,
        observation_id: sample.sampleId, status: 'complete', value: sample.reward }, first.event.userAttributes));
  }
  for (const credit of cohort.credits ?? []) {
    const exposure = input.exposures.find(e => e.event.eventId === credit.exposureId)!;
    records.push(analyticsRecord({ siteId, subjectKey: subjectKey(siteId, exposure.event.subject), ...exposure.event.subject },
      'credits', JSON.stringify([credit.goalEventId, credit.experimentId]), 1, credit.occurredAt, receivedAt, credit,
      { experiment_id: credit.experimentId, arm_id: credit.armId, assignment_id: credit.assignmentId,
        observation_id: credit.observationId, goal_id: credit.goalId, status: 'eligible', value: credit.value }));
  }
  return { cohort, records, next };
}
