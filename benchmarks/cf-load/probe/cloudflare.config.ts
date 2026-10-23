import {bindings,defineConfig,exports} from 'cf/config';
const name='eye-do-probe-20261023';
export default defineConfig({...(process.env.CLOUDFLARE_ACCOUNT_ID?{accountId:process.env.CLOUDFLARE_ACCOUNT_ID}:{}),worker:{
 name,entrypoint:'./worker.ts',compatibilityDate:'2026-10-23',compatibilityFlags:['nodejs_compat'],workersDev:true,
 observability:{enabled:true,headSamplingRate:0.1},
 exports:{MemoryProbe:exports.durableObject({storage:'sqlite'}),KvProbe:exports.durableObject({storage:'sqlite'}),SqlProbe:exports.durableObject({storage:'sqlite'})},
 env:{TEST_TOKEN:bindings.secret(), MEMORY:bindings.durableObject({worker:name,exportName:'MemoryProbe'}),KV:bindings.durableObject({worker:name,exportName:'KvProbe'}),SQL:bindings.durableObject({worker:name,exportName:'SqlProbe'})}
}});
