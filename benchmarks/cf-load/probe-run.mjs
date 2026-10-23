import{readFile,writeFile,mkdir}from'node:fs/promises';import{spawn}from'node:child_process';import{randomUUID}from'node:crypto';
const base=new URL('./',import.meta.url),{TEST_TOKEN}=JSON.parse(await readFile(new URL('.state/site-secrets.json',base)));
const url=process.env.PROBE_URL;if(!url)throw new Error('Set PROBE_URL to the independently deployed probe Worker URL');
const id=`probe-${Date.now()}-${randomUUID().slice(0,8)}`;await mkdir(new URL(`results/${id}/`,base),{recursive:true});
for(const kind of ['none','memory','kv-read','kv-write','sql-read','sql-write']){
 const run=`${id}-${kind}`,start=Date.now();console.log(JSON.stringify({kind,start}));
 const child=spawn('k6',['run','--quiet','load.js'],{cwd:base,env:{...process.env,URL:url,TEST_TOKEN,MODE:'baseline',ENDPOINT:kind,RATE:process.env.RATE??'10',DURATION:process.env.DURATION??'30s',RUN:run,POOL:`${id}-${kind}`,USERS:process.env.USERS??'20',NEW_FRACTION:'0',SUMMARY:`results/${id}/${kind}.json`},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const code=await new Promise(r=>child.on('close',r));await writeFile(new URL(`results/${id}/${kind}.log`,base),log);console.log(JSON.stringify({kind,code,end:Date.now()}));
}
console.log(JSON.stringify({output:`results/${id}`}));
