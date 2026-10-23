import { readFile, writeFile } from 'node:fs/promises';
const directory = new URL('./', import.meta.url);
const {url} = JSON.parse(await readFile(new URL('.state/deployment.json', directory)));
const {TEST_TOKEN} = JSON.parse(await readFile(new URL('.state/site-secrets.json', directory)));
const headers = { Authorization:`Bearer ${TEST_TOKEN}`, 'X-Session-ID':'smoke-returning', 'X-Goal':'purchase' };
const setup = await fetch(`${url}/setup?site=smoke`,{method:'POST',headers});
console.log('setup', setup.status, await setup.text());
for (let i=0;i<4;i++) {
  const r = await fetch(`${url}/page?site=smoke&run=smoke`,{headers:{...headers,'X-Request-ID':String(i)}});
  const data=await r.json(); delete data.fill;
  console.log('page',r.status,JSON.stringify(data));
  await new Promise(resolve=>setTimeout(resolve,2000));
}
const identity=await fetch(`${url}/identity?site=smoke`, { method:'POST', headers:{...headers,'X-Cid':'smoke-returning','X-Uid':'smoke-returning'} });
console.log('identity', identity.status, await identity.text());
for(let i=0;i<3;i++) {
  const r=await fetch(`${url}/page?site=smoke&run=smoke-login`,{headers:{...headers,'X-Authenticated':'1','X-Request-ID':`login-${i}`}});
  const data=await r.json(); delete data.fill; console.log('logged-in',r.status,JSON.stringify(data));
  await new Promise(resolve=>setTimeout(resolve,2000));
}
const r=await fetch(`${url}/report?site=smoke`,{headers});
const text=await r.text(); await writeFile(new URL('results/smoke-report.json',directory),text);
console.log('report',r.status,text.slice(0,500));
