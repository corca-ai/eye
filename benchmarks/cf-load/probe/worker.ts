import { DurableObject } from 'cloudflare:workers';
type Env=Omit<Cloudflare.Env,'MEMORY'|'KV'|'SQL'> & {
 MEMORY:DurableObjectNamespace<MemoryProbe>;KV:DurableObjectNamespace<KvProbe>;SQL:DurableObjectNamespace<SqlProbe>;
};
export class MemoryProbe extends DurableObject<Env>{ private value=0; read(){return this.value;} increment(){return ++this.value;} }
export class KvProbe extends DurableObject<Env>{
 read(){return this.ctx.storage.kv.get<number>('value')??0;}
 increment(){const n=this.read()+1;this.ctx.storage.kv.put('value',n);return n;}
}
export class SqlProbe extends DurableObject<Env>{
 constructor(ctx:DurableObjectState,env:Env){super(ctx,env);ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)');}
 read(){return this.ctx.storage.sql.exec<{value:number}>('SELECT value FROM counter WHERE id=1').toArray()[0]?.value??0;}
 increment(){return this.ctx.storage.sql.exec<{value:number}>('INSERT INTO counter VALUES (1,1) ON CONFLICT(id) DO UPDATE SET value=value+1 RETURNING value').one().value;}
}
export default {async fetch(request:Request,env:Env):Promise<Response>{
 if(!env.TEST_TOKEN)return new Response('Missing secret',{status:503});
 const hash=(s:string)=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));
 if(!crypto.subtle.timingSafeEqual(await hash(request.headers.get('Authorization')??''),await hash(`Bearer ${env.TEST_TOKEN}`)))return new Response('Unauthorized',{status:401});
 const url=new URL(request.url),mode=url.pathname.slice(1),id=request.headers.get('X-Session-ID')??crypto.randomUUID();
 const begin=performance.now();let value=0;
 if(mode==='memory')value=await env.MEMORY.getByName(id).read();
 else if(mode==='kv-read')value=await env.KV.getByName(id).read();
 else if(mode==='kv-write')value=await env.KV.getByName(id).increment();
 else if(mode==='sql-read')value=await env.SQL.getByName(id).read();
 else if(mode==='sql-write')value=await env.SQL.getByName(id).increment();
 else if(mode!=='none')return new Response('Unknown probe',{status:404});
 const data={mode,value,sessionMs:performance.now()-begin,eyeMs:0,metrics:[],submitted:0,rejected:0,fill:''};
 data.fill='x'.repeat(Math.max(0,4096-new TextEncoder().encode(JSON.stringify(data)).length));
 return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
}} satisfies ExportedHandler<Env>;
