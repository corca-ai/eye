import{readFile,writeFile,mkdir}from'node:fs/promises';import{spawn}from'node:child_process';import{randomUUID}from'node:crypto';
const base=new URL('./',import.meta.url),{url}=JSON.parse(await readFile(new URL('.state/deployment.json',base))),{url:proxy}=JSON.parse(await readFile(new URL('.state/proxy.json',base))),{TEST_TOKEN}=JSON.parse(await readFile(new URL('.state/site-secrets.json',base)));
const id=`fixed-${Date.now()}-${randomUUID().slice(0,6)}`,site=id,headers={Authorization:`Bearer ${TEST_TOKEN}`};
const setup=await fetch(`${url}/setup?site=${site}&profile=long`,{method:'POST',headers});if(!setup.ok)throw new Error(`setup ${setup.status}`);
await mkdir(new URL(`results/${id}`,base),{recursive:true});
const manifest={id,site,pool:id,proxy,startedAt:Date.now(),profile:'all observations 7 days; no foreground session RPC',extraRequests:'background /prepare requests, counted by client proxy'};await writeFile(new URL(`results/${id}/manifest.json`,base),JSON.stringify(manifest,null,2));
for(const [mode,rate,duration,label]of [['eye',10,'2m','warmup'],['baseline',10,'1m','baseline'],['eye',10,'2m','10'],['eye',100,'1m','100'],['eye',200,'1m','200']]){
 console.log(JSON.stringify({label,mode,rate,duration,at:Date.now()}));
 const run=`${id}-${label}`;
 const child=spawn('k6',['run','--quiet','load.js'],{cwd:base,env:{...process.env,URL:proxy,TEST_TOKEN,MODE:mode,RATE:String(rate),DURATION:duration,RUN:run,SITE:site,POOL:id,NEW_FRACTION:'0.05',SUMMARY:`results/${id}/${label}.json`},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const code=await new Promise(r=>child.on('close',r));await writeFile(new URL(`results/${id}/${label}.log`,base),log);console.log(JSON.stringify({label,code,at:Date.now()}));
 if(code!==0&&label!=='warmup'){console.log('Stopped after failed measurement gate');break;}
}
const metrics=await fetch(`${proxy}/metrics`).then(r=>r.json());await writeFile(new URL(`results/${id}/client.json`,base),JSON.stringify(metrics,null,2));console.log(JSON.stringify({output:`results/${id}`,metrics}));
