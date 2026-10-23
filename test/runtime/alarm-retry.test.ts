import { env } from 'cloudflare:workers';
import { runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';

it('backs off failed deliveries durably and does not let new work create a retry storm', async () => {
  const siteId=crypto.randomUUID(),subject={cid:'retry'},home=JSON.stringify([siteId,'cid','retry']);
  const target=env.SUBJECTS.getByName(home),at=Date.now();
  await target.ingest({siteId,receivedAt:at,event:{kind:'track',name:'test',eventId:'first',occurredAt:at,subject}});
  const first=await runInDurableObject(target,async(instance,state)=>{
    await state.storage.deleteAlarm();
    const clock=vi.spyOn(Date,'now').mockReturnValue(at+100);
    const flush=vi.spyOn(instance,'flush').mockRejectedValue(new Error('sink unavailable'));
    try{
      await instance.alarm();
      const retryAt=state.storage.kv.get<number>('alarmRetryAt');
      expect(retryAt).toBeGreaterThanOrEqual(at+2100);
      const scheduled=await state.storage.getAlarm();
      await instance.ingest({siteId,receivedAt:at+100,event:{kind:'track',name:'test',eventId:'new',occurredAt:at+100,subject}});
      expect(await state.storage.getAlarm()).toBe(scheduled);
      await instance.alarm(); // an early delivery cannot bypass the retry floor
      expect(flush).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(retryAt!+1);
      await instance.alarm();
      const next=state.storage.kv.get<number>('alarmRetryAt')!;
      expect(next).toBeGreaterThanOrEqual(retryAt!+4001);
      expect(state.storage.kv.get('alarmFailures')).toBe(2);
      return next;
    }finally{flush.mockRestore();clock.mockRestore();await state.storage.deleteAlarm();}
  });
  await evictDurableObject(target);
  await runInDurableObject(target,async(instance,state)=>{
    const clock=vi.spyOn(Date,'now').mockReturnValue(first+1);
    try{await instance.alarm();expect(state.storage.kv.get('alarmRetryAt')).toBeUndefined();expect(state.storage.kv.get('alarmFailures')).toBeUndefined();}
    finally{clock.mockRestore();await state.storage.deleteAlarm();}
  });
});
