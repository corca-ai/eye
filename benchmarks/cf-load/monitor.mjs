import {readFile,appendFile} from 'node:fs/promises';import{spawn}from'node:child_process';
const base=new URL('./',import.meta.url);const c=JSON.parse(await readFile(new URL('.state/resources.json',base)));
const file=new URL('results/queue-metrics.jsonl',base);
async function query(id){const p=spawn('cf',['queues','metrics','get',id],{env:{...process.env,CLOUDFLARE_ACCOUNT_ID:c.account},stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);const code=await new Promise(resolve=>p.on('close',resolve));return code===0?JSON.parse(out):{error:err};}
for(let i=0;i<125;i++) {const row={at:Date.now(),queue:await query(c.queue.queue_id),failed:await query(c.failed.queue_id)};await appendFile(file,JSON.stringify(row)+'\n');console.log(JSON.stringify(row));await new Promise(resolve=>setTimeout(resolve,30000));}
