// Optional deep audit; deliberately excluded from the regular unit-test suite.
// npm run build && node benchmarks/experiment-infrastructure/audit.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { addSample, emptyMoments } from '../../dist/core/moments.js';
import { evaluateUnreservedPolicy, chooseArm } from '../../dist/core/policy.js';
import { selectLocal } from '../../dist/core/local-assignment.js';
import { compareEvents } from '../../dist/core/attribution.js';
import { reduceClosedCohort } from '../../dist/core/closed-cohort.js';
import { settings } from '../../dist/core/validation.js';
import { IncrementalLearning } from '../../dist/runtime/incremental.js';
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const dayMs = 86_400_000, config = settings({minHoldMs:0});
let seed = 0x5eed;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
for (let trial = 0; trial < 2000; trial++) {
  const n = 1 + Math.floor(random() * 64), unit = 10 ** (random() * 12 - 6);
  const params = {...config, rewardScale:unit, bootstrapQuota:1 + Math.floor(random()*100),
    bootstrapShare:.001 + random()*.998, explorationFloor:trial%10 === 0 ? 1 : .001 + random()*.999};
  const now = Math.floor(random()*30*dayMs);
  const arms = Array.from({length:n}, (_,i) => {
    let moments = emptyMoments(0);
    const count = Math.floor(random()*6);
    for (let j=0;j<count;j++) moments = addSample(moments,(random()-.5)*unit*100,random()*100);
    return {armId:`arm-${i}`,moments};
  });
  const policy = evaluateUnreservedPolicy(arms,params,now);
  assert.deepEqual(policy,evaluateUnreservedPolicy([...arms].reverse(),params,now));
  near(policy.arms.reduce((sum,a) => sum+a.probability,0),1,1e-12);
  for (const arm of policy.arms) {
    assert.ok(Number.isFinite(arm.score));
    assert.ok(arm.probability >= params.explorationFloor/n - 1e-14 && arm.probability <= 1+1e-14);
  }
  const cold = policy.arms.filter(arm => arm.weight < params.bootstrapQuota);
  if (cold.length < n) assert.ok(cold.reduce((sum,a) => sum+a.probability,0)
    <= Math.max(params.explorationFloor*cold.length/n,Math.min(params.bootstrapShare,cold.length/n)) + 1e-14);
  assert.ok(policy.arms.includes(chooseArm(policy,random())));
}
const counts = [0,0], joint = new Map();
for (let i=0;i<20000;i++) {
  const subject = {cid:`device-${i}`,uid:`사용자:${i}`};
  const arms = ['checkout','landing'].map((experimentId,index) => {
    const result = selectLocal({siteId:'site',experimentId,subject,now:10,newId:()=>`a-${i}`,
      policy:{siteId:'site',experimentId,generation:1,revision:1,sequence:1,publishedAt:0,freshUntil:1000,usableUntil:5000,active:true,
        arms:[{armId:'a',probability:.3},{armId:'b',probability:.7}],settings:config,attributionWindowMs:1000}});
    assert.equal(result.status,'assigned');
    const arm = result.context.assignment.armId;
    if (arm === 'a') counts[index]++;
    return arm;
  });
  const key = arms.join(''); joint.set(key,(joint.get(key)??0)+1);
}
for (const count of counts) near(count/20000,.3,.015);
for (const [key,p] of [['aa',.09],['ab',.21],['ba',.21],['bb',.49]]) near((joint.get(key)??0)/20000,p,.015);

// Mixed ordered streams independently compare the durable learner to the raw
// reference reducer. Cross-batch reordering is a documented approximation and
// intentionally is not claimed to match a globally sorted raw-event ledger.
const start = 1_800_000_000_000, end = start + 120_000;
function stream(initialSeed) {
  let state = initialSeed;
  const draw = n => { state = (Math.imul(state,1664525)+1013904223)>>>0; return Math.floor(state/4294967296*n); };
  const events = [];
  for (let i=0;i<180;i++) {
    const subject = {cid:`c-${draw(4)}`,...(draw(3) ? {uid:`u-${draw(3)}`} : {})};
    const at=start+draw(100),eventId=`id-${i}`;
    switch (i%4) {
      case 0: {
        const params=settings({minHoldMs:0,observationWindowMs:10+draw(90),attributionHalfLifeMs:20+draw(80)});
        events.push({kind:'exposure',eventId,occurredAt:at,subject,
          assignment:{assignmentId:eventId,experimentId:`exp-${draw(4)}`,armId:`arm-${draw(2)}`,generation:1+draw(2),
            assignedAt:at,probability:.5,policyRevision:1,settings:params},
          sample:{sampleId:`sample-${i}`,startAt:at},attributionWindowMs:1+draw(80)});
        break;
      }
      case 1: events.push({kind:'goal',eventId,occurredAt:at,subject,goalId:`goal-${draw(2)}`,value:draw(101)-30}); break;
      case 2: events.push({kind:'track',eventId,occurredAt:at,subject,name:'view'}); break;
      case 3: events.push({kind:subject.uid ? 'identify':'logout',eventId,occurredAt:at,subject}); break;
    }
  }
  return events.sort(compareEvents);
}
const seeds = [1,7,29,103,1234,7159,65537,3735928559];
for (const seed of seeds) {
  const events=stream(seed);
  const reference=reduceClosedCohort({cohortId:'audit',from:start,until:end,asOf:end,
    exposures:events.filter(e=>e.kind==='exposure').map(event=>({event,...event.sample,attributionWindowMs:event.attributionWindowMs})),
    goals:events.filter(e=>e.kind==='goal'),identities:events.filter(e=>['identify','logout','anonymous'].includes(e.kind))});
  for (const batchSize of [1,17,100]) {
    const db=new DatabaseSync(':memory:');
    const sql={exec(query,...bindings) {
      let rows;
      if (query.trimStart().startsWith('CREATE ')) {db.exec(query);rows=[];}
      else rows=db.prepare(query).all(...bindings);
      return {toArray:()=>rows,[Symbol.iterator]:()=>rows[Symbol.iterator]()};
    }};
    let engine=new IncrementalLearning(sql,start);
    try {
      for (let offset=0;offset<events.length;offset+=batchSize) {
        const batch=events.slice(offset,offset+batchSize),now=batch.at(-1).occurredAt;
        engine.accept(batch,now);engine.accept(batch,now);engine=new IncrementalLearning(sql,now);
      }
      engine.close('site',end,()=>{});
      const observations=new Map(engine.outputs().flatMap(r=>r.output.records).map(r=>[r.record_id,r.value]));
      assert.equal(observations.size,reference.samples.length);
      for (const sample of reference.samples) near(observations.get(sample.sampleId),sample.reward);
      for (let i=0;i<4;i++) {
        const experimentId=`exp-${i}`,report=engine.dashboard.query({experimentId,boundaries:[start,end]},end);
        const samples=reference.samples.filter(s=>s.assignment.experimentId===experimentId),expected=samples.reduce((sum,s)=>sum+s.reward,0);
        near(report.rewards.reduce((sum,r)=>sum+r.totalValue,0),expected);
        near(report.learning.reduce((sum,r)=>sum+r.learningValue,0),expected);
        assert.equal(report.learning.reduce((sum,r)=>sum+r.completed,0),samples.length);
        assert.equal(report.traffic.reduce((sum,r)=>sum+r.exposures,0),events.filter(e=>e.kind==='exposure'&&e.assignment.experimentId===experimentId).length);
      }
    } finally {db.close();}
  }
}
console.log(JSON.stringify({policyStates:2000,identities:20000,selectionShares:counts.map(n=>n/20000),joint:Object.fromEntries(joint),
  learningSeeds:seeds.length,batchSizes:[1,17,100],duplicates:true,restarts:true,result:'passed'}));
