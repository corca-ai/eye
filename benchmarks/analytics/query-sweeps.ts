// Local memory SQLite, never a Basin latency, scan-byte or billing estimate.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { database } from '../../test/helpers/analytics-db.js';
import { temporalExposure as exposure, TEMPORAL_NOW as now, TEMPORAL_START as start } from '../../test/helpers/temporal-stream.js';
import { rawRecords } from '../../src/analytics/raw.js';
import { attributionCTEs } from '../../src/analytics/attribution-sql.js';
import { AnalyticsSQL } from '../../src/analytics/sql.js';
import { attributionCTEs as reference } from './reference-sweep-attribution.js';
import { AnalyticsSQL as ReferenceSQL } from './reference-sweep-sql.js';
import type { EyeEvent } from '../../src/core/types.js';
const args = ['eye', "'site'", now - 60 * 86_400_000, start, now, now] as const;
const records = (events: EyeEvent[]) => events.flatMap(event => rawRecords({ siteId: 'site', receivedAt: now, event }));
function median(run: () => unknown) {
  const times: number[] = [];
  for (let i = 0; i < 4; i++) { const at = performance.now(); run(); if (i) times.push(performance.now() - at); }
  return times.sort((a,b) => a-b)[1]!;
}
const boundaries = [], existence = [], denominator = [];
for (const n of [80,160,320]) {
  const events: EyeEvent[] = [];
  for (let i=0;i<n;i++) {
    events.push(exposure(`e-${i}`, start+i, { cid:'c' }),
      {kind:i%2?'identify':'logout',eventId:`i-${i}`,occurredAt:start+i,subject:{cid:'c',...(i%2?{uid:'u'}:{})}});
  }
  const db=database(records(events));
  try {
    const select='SELECT b.exposure_key,b.previous_kind,a.next_kind,a.next_uid,a.next_at,a.next_id FROM ac_before b JOIN ac_after a ON a.exposure_key=b.exposure_key ORDER BY b.exposure_key';
    const old=`WITH ${reference(...args).join(',')} ${select}`, next=`WITH ${attributionCTEs(...args).join(',')} ${select}`;
    assert.deepEqual(db.run(next),db.run(old));
    boundaries.push({exposures:n,links:n,beforePotentialPairs:n*n,afterStreamRows:2*n,beforeMs:median(()=>db.run(old)),afterMs:median(()=>db.run(next))});
  } finally {db.close();}
}
for (const n of [80,160,320]) {
  const events:EyeEvent[]=[];
  for(let i=0;i<n;i++)events.push(exposure(`e-${i}`,start+i,{cid:'c',uid:'u'}));
  for(let i=0;i<n;i++)events.push({kind:'track',eventId:`t-${i}`,occurredAt:start+n+i,subject:{cid:'c',uid:'u'},name:'view'});
  const db=database(records(events));
  try {
    const query={from:start,to:now,experimentId:'exp',hasEvent:{name:'view'}};
    const old=new ReferenceSQL('eye','site',now).arms(query).sql,next=new AnalyticsSQL('eye','site',now).arms(query).sql;
    assert.deepEqual(db.run(next),db.run(old));
    const oldPrefix=old.slice(0,old.indexOf(',\ncohort AS')).replace('SELECT DISTINCT o.observation_id','SELECT o.observation_id');
    const nextPrefix=next.slice(0,next.indexOf(',\ncohort AS'));
    existence.push({observations:n,tracks:n,beforePairs:db.run(oldPrefix+' SELECT COUNT(*) AS n FROM matching_event_observations')[0]!.n,
      afterProbes:db.run(nextPrefix+' SELECT COUNT(*) AS n FROM he_probes')[0]!.n,beforeMs:median(()=>db.run(old)),afterMs:median(()=>db.run(next))});
  } finally {db.close();}
}
for(const experiments of [1,2,4,8,32,128]) {
  const events:EyeEvent[]=[],subject={cid:'c',uid:'u'};
  for(let e=0;e<experiments;e++)for(let cycle=0;cycle<2;cycle++)events.push(exposure(`e-${e}-${cycle}`,start+e+cycle*1000,subject,`exp-${e}`));
  for(let i=0;i<200;i++)events.push({kind:'goal',eventId:`g-${i}`,occurredAt:start+200+i*10,subject,goalId:'pay',value:i%2?-30:100});
  const db=database(records(events));
  try {
    const old=reference(...args),next=attributionCTEs(...args,undefined,"'exp-0'");
    const query=(ctes:string[])=>`WITH ${ctes.join(',')} SELECT * FROM credits_latest WHERE experiment_id='exp-0' ORDER BY record_id`;
    assert.deepEqual(db.run(query(next)),db.run(query(old)));
    const oldRows=db.run(`WITH ${old.join(',')} SELECT COUNT(*) AS n FROM ac_eligible`)[0]!.n;
    const work=db.run(`WITH ${next.join(',')} SELECT (SELECT COUNT(*) FROM ac_delta_edges) AS endpointRows,(SELECT COUNT(*) FROM ac_target_matches) AS targetRows`)[0];
    denominator.push({experiments,goals:200,beforeEligibleRows:oldRows,...work,beforeMs:median(()=>db.run(query(old))),afterMs:median(()=>db.run(query(next)))});
  } finally {db.close();}
}
console.log(JSON.stringify({runtime:process.version,platform:process.platform,baseline:'020d2bd',method:'identical immutable inputs; exact result equality; one warmup + three measured runs; median',limitations:'Synthetic local SQLite; work counters are logical rows, not physical read counts. Original input reads remain. No remote Basin EXPLAIN, performance or billing measurement.',boundaries,existence,denominator},null,2));
