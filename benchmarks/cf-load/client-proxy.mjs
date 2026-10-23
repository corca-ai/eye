// Load-generator-side browser token state. No user state is cached in a Worker.
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
const base=new URL('./',import.meta.url),{url:upstream}=JSON.parse(await readFile(new URL('.state/deployment.json',base)));
const secrets=JSON.parse(await readFile(new URL('.state/site-secrets.json',base)));
const states=new Map(),pending=new Set(),queue=[];
let active=0,stopped=false;
const counts={prepared:0,failed:0,primary:0};
function deadlines(tokens){
 if(Object.keys(tokens).length<3)return {until:0,refreshAt:0};
 const states=Object.values(tokens).map(token=>{try{return JSON.parse(Buffer.from(token.split('.')[0],'base64url'));}catch{return {until:0,refreshAt:0};}});
 return {until:Math.min(...states.map(s=>s.until)),refreshAt:Math.min(...states.map(s=>s.refreshAt??s.until-60000))};
}
function prepare(key,state){
 if(pending.has(key)||state.retryAt>Date.now())return;
 pending.add(key);queue.push({key,state});pump();
}
function pump(){while(!stopped&&active<4&&queue.length){const{key,state}=queue.shift();active++;
 fetch(`${upstream}/prepare?site=${encodeURIComponent(state.site)}`,{method:'POST',headers:{Authorization:`Bearer ${secrets.TEST_TOKEN}`,'X-Session-ID':state.sid,'X-Authenticated':state.auth},signal:AbortSignal.timeout(30000)})
 .then(async r=>{if(!r.ok)throw new Error(`prepare ${r.status}`);const body=await r.json();const previous=state.until;state.tokens=Object.fromEntries(Object.entries(body.tokens).filter(([,v])=>typeof v==='string'));Object.assign(state,deadlines(state.tokens));state.retryAt=state.until<=previous&&state.until>Date.now()?state.until:Date.now()+5000;counts.prepared++;})
 .catch(()=>{state.retryAt=Date.now()+10000;counts.failed++;})
 .finally(()=>{active--;pending.delete(key);pump();});
}}
const server=createServer(async(req,res)=>{
 try{
 const incoming=new URL(req.url,'http://localhost');
 if(incoming.pathname==='/metrics'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...counts,pending:pending.size,active,states:states.size}));return;}
 const sid=req.headers['x-session-id'],auth=req.headers['x-authenticated']??'0',site=incoming.searchParams.get('site')??'load';
 if(typeof sid!=='string'){res.writeHead(400);res.end();return;}
 const key=JSON.stringify([site,sid,auth]);
 let state=states.get(key);
 if(!state){state={site,sid,auth,tokens:{},until:0,refreshAt:0,retryAt:0};states.set(key,state);}
 if(states.size>10000){for(const old of states.keys()){if(!pending.has(old)&&old!==key){states.delete(old);break;}}}
 if(incoming.searchParams.get('mode')!=='baseline'&&state.refreshAt<=Date.now())prepare(key,state);
 incoming.pathname='/fast-page';
 const headers={Authorization:`Bearer ${secrets.TEST_TOKEN}`,'X-Session-ID':sid,'X-Authenticated':auth,'X-Request-ID':req.headers['x-request-id']??crypto.randomUUID(),'X-Goal':req.headers['x-goal']??'','X-Eye-Tokens':JSON.stringify(state.tokens)};
 const response=await fetch(`${upstream}${incoming.pathname}${incoming.search}`,{headers,signal:AbortSignal.timeout(10000)});
 res.writeHead(response.status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(Buffer.from(await response.arrayBuffer()));counts.primary++;
 }catch{res.writeHead(502);res.end('{"error":"upstream failed"}');}
});
server.listen(0,'127.0.0.1',async()=>{const a=server.address();await writeFile(new URL('.state/proxy.json',base),JSON.stringify({url:`http://127.0.0.1:${a.port}`}));console.log(JSON.stringify({url:`http://127.0.0.1:${a.port}`}));});
function stop(){stopped=true;queue.length=0;server.close();setTimeout(()=>process.exit(),1000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
