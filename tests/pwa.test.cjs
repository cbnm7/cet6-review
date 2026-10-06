const {test}=require('node:test');const assert=require('node:assert/strict');const {createSW}=require('./support/sw-harness.cjs');
test('new version precaches the edit sync model with the complete app',async()=>{
  const sw=createSW();await sw.dispatch('install');const cache=await sw.caches.open('reading-words-3.2.0');
  for(const name of ['sync-model.js','db.js','app.js','cloud-sync.js'])assert.ok(await cache.match(sw.base+name+'?v=3.2.0'));assert.equal(sw.counts().skipped,1);
});
test('activation only removes old app static caches',async()=>{
  const sw=createSW();await sw.caches.open('reading-words-3.1.0');await sw.caches.open('cet6-review-old');await sw.caches.open('unrelated-cache');await sw.caches.open('reading-words-3.2.0');
  await sw.dispatch('activate');assert.deepEqual((await sw.caches.keys()).sort(),['reading-words-3.2.0','unrelated-cache']);assert.equal(sw.counts().claimed,1);
});
test('program resources are network-first',async()=>{
  const sw=createSW();const request=sw.request('app.js?v=3.2.0');const cache=await sw.caches.open('reading-words-3.2.0');await cache.put(request,new Response('old'));sw.setFetch(async()=>new Response('new'));
  assert.equal(await (await sw.dispatch('fetch',{request})).text(),'new');
});
test('offline resource fetch falls back to cache',async()=>{
  const sw=createSW();await sw.dispatch('install');sw.setFetch(async()=>{throw new Error('offline');});
  assert.match(await(await sw.dispatch('fetch',{request:sw.request('sync-model.js?v=3.2.0')})).text(),/NETWORK/);
});
test('offline navigation uses cached index',async()=>{
  const sw=createSW();await sw.dispatch('install');sw.setFetch(async()=>{throw new Error('offline');});
  assert.match(await(await sw.dispatch('fetch',{request:sw.request('?offline=1','navigate')})).text(),/index.html/);
});
test('temporary server errors fall back to cache',async()=>{
  const sw=createSW();await sw.dispatch('install');sw.setFetch(async()=>new Response('down',{status:503}));
  const response=await sw.dispatch('fetch',{request:sw.request('app.js?v=3.2.0')});assert.equal(response.status,200);assert.match(await response.text(),/NETWORK/);
});
test('Supabase and non-GET requests are not cached or intercepted',async()=>{
  const sw=createSW();assert.equal(await sw.dispatch('fetch',{request:{url:'https://cloud.example/rest/v1/words',method:'GET'}}),undefined);
  assert.equal(await sw.dispatch('fetch',{request:{url:sw.base,method:'POST'}}),undefined);
});
test('cache quota failure does not prevent live app response',async()=>{
  const sw=createSW();sw.caches.failPut=true;sw.setFetch(async()=>new Response('live'));assert.equal(await(await sw.dispatch('fetch',{request:sw.request('app.js')})).text(),'live');
});
