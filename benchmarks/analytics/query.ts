// Local SQLite comparison, not Basin execution-plan or billing evidence.
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { database } from '../../test/helpers/analytics-db.js';
import { queryStream, QUERY_NOW as now, QUERY_DAY as day } from '../../test/helpers/query-stream.js';
import { attributionCTEs } from '../../src/analytics/attribution-sql.js';
import { attributionCTEs as reference } from './reference-attribution.js';
for (const users of [25,75]) {
 const rows=queryStream(users),db=database(rows);
 const args=['eye',"'site'",now-60*day,now-2*day,now,now] as const;
 const query=(fn:typeof attributionCTEs)=>`WITH ${fn(...args).join(',')} SELECT * FROM credits_latest ORDER BY record_id`;
 const old=query(reference),next=query(attributionCTEs);
 const expected=db.run(old); assert.deepEqual(db.run(next),expected);
 const measure=(sql:string)=>{const times=[];for(let i=0;i<4;i++){const start=performance.now();db.run(sql);if(i)times.push(performance.now()-start);}return times.sort((a,b)=>a-b)[1];};
 console.log(JSON.stringify({users,rows:rows.length,credits:expected.length,beforeMs:measure(old),afterMs:measure(next)}));db.close();
}
