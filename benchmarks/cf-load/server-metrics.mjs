import {readFile,writeFile} from 'node:fs/promises';
const base=new URL('./',import.meta.url);
const c=JSON.parse(await readFile(new URL('.state/resources.json',base),'utf8'));
const profile=process.env.CF_PROFILE_FILE??`${process.env.HOME}/Library/Preferences/cloudflare/config/default.json`;
const auth=JSON.parse(await readFile(profile,'utf8'));
const namespaces=JSON.parse(await readFile(new URL('.state/namespaces.json',base),'utf8'));
const since=new Date(process.argv[2]??Date.now()-3600000).toISOString();
const until=new Date(process.argv[3]??Date.now()).toISOString();
if (since >= until) throw new Error('since must precede until');
const filter=`{scriptName_in:["${c.prefix}","${c.prefix}-site"],datetime_geq:"${since}",datetime_leq:"${until}"}`;
const query=`{viewer{accounts(filter:{accountTag:"${c.account}"}){
r2:r2OperationsAdaptiveGroups(limit:100,filter:{bucketName:"${c.prefix}-data",datetime_geq:"${since}",datetime_leq:"${until}"}){dimensions{actionType}sum{requests}}
catalog:r2CatalogDataOperationsAdaptiveGroups(limit:100,filter:{warehouseName:"${c.account}_${c.prefix}-data",datetime_geq:"${since}",datetime_leq:"${until}"}){dimensions{operation namespaceName}count}
maintenance:r2CatalogTableMaintenanceAdaptiveGroups(limit:100,filter:{warehouseName:"${c.account}_${c.prefix}-data",datetime_geq:"${since}",datetime_leq:"${until}"}){dimensions{jobType namespaceName success}count sum{filesProcessed filesOutput inputBytes outputBytes}}
pipeline:pipelinesOperatorAdaptiveGroups(limit:10,filter:{pipelineId:"${c.pipeline.id}",streamId_neq:"",datetime_geq:"${since}",datetime_leq:"${until}"}){sum{bytesIn recordsIn decodeErrors}}
sinks:pipelinesSinkAdaptiveGroups(limit:20,filter:{pipelineId:"${c.pipeline.id}",datetime_geq:"${since}",datetime_leq:"${until}"}){dimensions{sinkId}sum{bytesWritten recordsWritten filesWritten uncompressedBytesWritten}}
pipelineErrors:pipelinesUserErrorsAdaptiveGroups(limit:100,filter:{pipelineId:"${c.pipeline.id}",datetime_geq:"${since}",datetime_leq:"${until}"}){dimensions{errorFamily errorType}count}
queue:queueMessageOperationsAdaptiveGroups(limit:20,filter:{queueId:"${c.queue.queue_id}",datetime_geq:"${since}",datetime_leq:"${until}"}){dimensions{actionType outcome}count sum{billableOperations bytes}avg{lagTime retryCount}max{messageSize}}
workers:workersInvocationsAdaptive(limit:100,filter:${filter}){dimensions{scriptName}sum{requests errors cpuTimeUs requestDuration wallTime}quantiles{cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99}}
objects:durableObjectsInvocationsAdaptiveGroups(limit:100,filter:${filter}){dimensions{scriptName namespaceId coloCode}sum{requests errors wallTime}quantiles{cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99}}
storage:durableObjectsPeriodicGroups(limit:100,filter:{namespaceId_in:${JSON.stringify(namespaces.map(n=>n.id))},datetime_geq:"${since}",datetime_leq:"${until}"}){dimensions{namespaceId}sum{rowsRead rowsWritten cpuTime duration fatalInternalErrors exceededCpuErrors exceededMemoryErrors}}
}}}`;
const r=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{Authorization:`Bearer ${auth.oauth_token}`,'Content-Type':'application/json'},body:JSON.stringify({query})});
const data=await r.json();
await writeFile(process.argv[4]??new URL('results/server-metrics-latest.json',base),JSON.stringify({since,until,...data},null,2));
if (!r.ok || data.errors?.length || !data.data?.viewer?.accounts?.length) throw new Error('GraphQL metrics failed; inspect saved response');
console.log(JSON.stringify(data).slice(0,10000));
