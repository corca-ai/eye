import { expect, it } from 'vitest';
import { IdentityHistory } from '../../src/core/identity-history.js';
import { parseEvent } from '../../src/core/events.js';

it('an anonymous-state check preserves anonymous exposure, but logout deliberately ends it', () => {
  const at = (eventId: string, occurredAt: number, uid?: string) => ({eventId, occurredAt, subject: {cid: 'browser', ...(uid ? {uid} : {})}});
  const exposure = at('shown', 10), goal = at('goal', 40, 'account');
  const initial = parseEvent({...at('initial', 20), kind: 'anonymous'});
  const login = parseEvent({...at('login', 30, 'account'), kind: 'identify'});
  if (initial.kind !== 'anonymous' || login.kind !== 'identify') throw new Error('Identity parser');
  expect(new IdentityHistory([initial, login]).matches(exposure, goal)).toBe(true);
  expect(new IdentityHistory([{...at('logout', 20), kind: 'logout'}, login]).matches(exposure, goal)).toBe(false);
  const previousLogin = {...at('previous', 5, 'another'), kind: 'identify' as const};
  expect(new IdentityHistory([previousLogin, initial, login]).matches(exposure, goal)).toBe(false);
  expect(() => parseEvent({...at('invalid', 20, 'account'), kind: 'anonymous'})).toThrow();
});

import { rawRecords } from '../../src/analytics/raw.js';
import { database } from '../helpers/analytics-db.js';
import { BasinAnalytics } from '../../src/analytics/query.js';
import { settings } from '../../src/core/validation.js';
it('raw SQL and processing agree that initial anonymous checks do not sever login attribution', async () => {
  const now = Date.now(), start = now - 10_000;
  const assignment = {assignmentId:'assignment',experimentId:'landing',armId:'original',generation:1,policyRevision:1,assignedAt:start,probability:1,settings:settings({minHoldMs:0,observationWindowMs:60_000})};
  const events = [
    {kind:'track' as const,eventId:'track',occurredAt:start,subject:{cid:'browser'},name:'page_view'},
    {kind:'exposure' as const,eventId:'shown',occurredAt:start,subject:{cid:'browser'},assignment,sample:{sampleId:'sample',startAt:start},attributionWindowMs:60_000},
    {kind:'anonymous' as const,eventId:'anonymous',occurredAt:start+1,subject:{cid:'browser'}},
    {kind:'identify' as const,eventId:'login',occurredAt:start+2,subject:{cid:'browser',uid:'account'}},
    {kind:'goal' as const,eventId:'goal',occurredAt:start+3,subject:{cid:'server:account',uid:'account'},goalId:'signup',value:1000}];
  const db = database(events.flatMap(event => rawRecords({siteId:'site',receivedAt:now,event})));
  try {
    const analytics = new BasinAnalytics({EYE_ANALYTICS_WAREHOUSE:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_bucket',EYE_ANALYTICS_TOKEN:'test'},'site',db.request,()=>now);
    const result = await analytics.rewardSeries({experimentId:'landing',from:start,to:now,bucketMs:60_000});
    expect(result.rows.reduce((sum,row) => sum+row.goals,0)).toBe(1);
    const timeline = await analytics.timeline({subject:{uid:'account'},from:start,to:now});
    expect(timeline.rows.some(row => row.recordId === 'track')).toBe(true);
  } finally {db.close();}
});
