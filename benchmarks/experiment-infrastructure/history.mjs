// npm run build && node benchmarks/experiment-infrastructure/history.mjs --output=/tmp/history.json
// Optional --dist=/path/to/other/dist compares the same fixture with another build.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const dist = resolve(options.dist ?? 'dist');
const { Dashboard } = await import(pathToFileURL(resolve(dist, 'runtime/dashboard.js')));
const day = 86_400_000, minute = 60_000, start = 1_800_000_000_000;
const workloads = [];
for (const [experiments, days, publishMinutes] of [[2,30,15],[20,30,15],[2,30,1],[100,59,60]]) {
  const db = new DatabaseSync(':memory:');
  const sql = {exec(query,...bindings) {
    let rows;
    if (query.trimStart().startsWith('CREATE ')) {db.exec(query);rows=[];}
    else rows=db.prepare(query).all(...bindings);
    return {toArray:()=>rows,[Symbol.iterator]:()=>rows[Symbol.iterator]()};
  }};
  const dashboard = new Dashboard(sql,start);
  const insert = db.prepare('INSERT INTO dashboard_policies VALUES (?,?,?,?)');
  const publications = days*1440/publishMinutes;
  db.exec('BEGIN');
  const setupStart=performance.now();
  for (let sequence=0;sequence<publications;sequence++) {
    const occurredAt=start+sequence*publishMinutes*minute;
    const data=JSON.stringify(['a','b','c'].map(armId=>({occurredAt,armId,generation:1,status:'active',
      probability:1/3,meanReward:sequence,score:sequence,scoreScale:1})));
    for (let i=0;i<experiments;i++) insert.run(`exp-${i}`,sequence,occurredAt,data);
  }
  db.exec('COMMIT');
  const setupMs=performance.now()-setupStart;
  const to=start+days*day, from=to-day;
  const query={experimentId:'exp-0',boundaries:[from,to]};
  const expected=(1440/publishMinutes)*3;
  const inspect=()=>{
    const report=dashboard.query(query,to);
    assert.equal(report.policies.length,expected);
    assert.equal(report.policies[0].occurredAt,from);
    assert.equal(report.policies.at(-1).occurredAt,to-publishMinutes*minute);
    assert.equal(report.policies[0].meanReward,publications-1440/publishMinutes);
    return createHash('sha256').update(JSON.stringify(report)).digest('hex');
  };
  const digest=inspect();
  for(let i=0;i<5;i++) dashboard.query(query,to);
  const runs=[];
  for(let i=0;i<11;i++) {
    const before=performance.now();dashboard.query(query,to);runs.push(performance.now()-before);
  }
  assert.equal(inspect(),digest);
  const plan=db.prepare('EXPLAIN QUERY PLAN SELECT data FROM dashboard_policies WHERE experiment_id=? AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at LIMIT 5001').all('exp-0',from,to).map(row=>row.detail);
  const sorted=[...runs].sort((a,b)=>a-b);
  const bytes=db.prepare('PRAGMA page_count').get().page_count*db.prepare('PRAGMA page_size').get().page_size;
  workloads.push({experiments,days,publishMinutes,rows:experiments*publications,replyCells:expected,medianMs:sorted[5],p95Ms:sorted[10],runs,plan,setupMs,databaseBytes:bytes,digest});
  db.close();
}
const result={runtime:process.version,platform:`${process.platform}/${process.arch}`,
  sourceHash:createHash('sha256').update(await readFile(resolve(dist,'runtime/dashboard.js'))).digest('hex'),
  limitations:'Synthetic policy publication history; actual Dashboard.query on local in-memory SQLite. Query one day within retained history; no network, durable disk commit or Worker scheduling. Setup time includes fixture JSON encoding.',workloads};
if(options.output) await writeFile(options.output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
