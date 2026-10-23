import {readFile,writeFile} from 'node:fs/promises';
const base=new URL('./',import.meta.url);
const c=JSON.parse(await readFile(new URL('.state/resources.json',base),'utf8'));
const profile=process.env.CF_PROFILE_FILE??`${process.env.HOME}/Library/Preferences/cloudflare/config/default.json`;
const auth=JSON.parse(await readFile(profile,'utf8'));
const namespaces=JSON.parse(await readFile(new URL('.state/namespaces.json',base),'utf8'));
const since=process.argv[2]??new Date(Date.now()-3600000).toISOString();
const until=new Date().toISOString();
const filter=`{scriptName_in:["${c.prefix}","${c.prefix}-site"],datetime_geq:"${since}",datetime_leq:"${until}"}`;
const query=`{viewer{accounts(filter:{accountTag:"${c.account}"}){
workers:workersInvocationsAdaptive(limit:100,filter:${filter}){dimensions{scriptName}sum{requests errors cpuTimeUs requestDuration wallTime}quantiles{cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99}}
objects:durableObjectsInvocationsAdaptiveGroups(limit:100,filter:${filter}){dimensions{scriptName namespaceId coloCode}sum{requests errors wallTime}quantiles{cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99}}
storage:durableObjectsPeriodicGroups(limit:100,filter:{namespaceId_in:${JSON.stringify(namespaces.map(n=>n.id))},datetime_geq:"${since}",datetime_leq:"${until}"}){dimensions{namespaceId}sum{rowsRead rowsWritten cpuTime duration fatalInternalErrors exceededCpuErrors exceededMemoryErrors}}
}}}`;
const r=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{Authorization:`Bearer ${auth.oauth_token}`,'Content-Type':'application/json'},body:JSON.stringify({query})});
const data=await r.json();
await writeFile(new URL('results/server-metrics-latest.json',base),JSON.stringify({since,until,...data},null,2));
console.log(JSON.stringify(data).slice(0,10000));
