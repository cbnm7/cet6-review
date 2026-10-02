const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');const {createSW}=require('./support/sw-harness.cjs');
const {root}=require('./support/harness.cjs');

test('核心JS/CSS/页面网络优先，网络结果写入缓存，绕过HTTP旧缓存',async()=>{
 const h=createSW();const request=h.request('app.js?v=2.2.2');
 await(await h.caches.open(h.run('STATIC_CACHE'))).put(request,new Response('OLD'));
 h.setFetch(async()=>new Response('NEW'));
 assert.equal(await(await h.dispatch('fetch',{request})).text(),'NEW');
 assert.equal(h.calls[0].options.cache,'no-store');
 h.setFetch(async()=>{throw new Error('offline');});
 assert.equal(await(await h.dispatch('fetch',{request})).text(),'NEW');
});
test('离线优先取最新运行时缓存，而不是旧预缓存',async()=>{
 const h=createSW();const request=h.request('scheduler.js?v=2.2.2');
 await(await h.caches.open(h.run('STATIC_CACHE'))).put(request,new Response('STATIC OLD'));
 await(await h.caches.open(h.run('RUNTIME_CACHE'))).put(request,new Response('RUNTIME LATEST'));
 h.setFetch(async()=>{throw new Error('offline');});
 assert.equal(await(await h.dispatch('fetch',{request})).text(),'RUNTIME LATEST');
});
test('500/404不覆盖可用缓存，断网无缓存返回明确503而非undefined',async()=>{
 const h=createSW();const request=h.request('db.js?v=2.2.2');await(await h.caches.open(h.run('STATIC_CACHE'))).put(request,new Response('GOOD'));
 for(const status of [500,404]){h.setFetch(async()=>new Response('ERROR',{status}));assert.equal(await(await h.dispatch('fetch',{request})).text(),'GOOD');}
 h.setFetch(async()=>{throw new Error('offline');});assert.equal((await h.dispatch('fetch',{request:h.request('not-cached.js')})).status,503);
});
test('网络超时回退缓存，不会无限等待',async()=>{
 const h=createSW();const request=h.request('style.css?v=2.2.2');await(await h.caches.open(h.run('STATIC_CACHE'))).put(request,new Response('CACHED CSS'));
 h.setFetch((r,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('timeout')))));
 assert.equal(await(await h.dispatch('fetch',{request})).text(),'CACHED CSS');
});
test('词库/词典/图标缓存优先，命中时不联网',async()=>{
 const h=createSW();for(const resource of ['data/cet6_2003.json?v=2.2.2','data/concise-dictionary.js?v=2.2.2','icons/icon-192.png']){
  const request=h.request(resource);await(await h.caches.open(h.run('STATIC_CACHE'))).put(request,new Response('FIXED'));
  assert.equal(await(await h.dispatch('fetch',{request})).text(),'FIXED');
 }assert.equal(h.calls.length,0);
});
test('导航更新公共离线首页，带不同查询参数的离线入口也使用新首页',async()=>{
 const h=createSW();h.setFetch(async()=>new Response('NEW HOME'));
 await h.dispatch('fetch',{request:h.request('?entry=qq','navigate')});
 h.setFetch(async()=>{throw new Error('offline');});
 assert.equal(await(await h.dispatch('fetch',{request:h.request('?entry=chrome','navigate')})).text(),'NEW HOME');
});
test('缓存配额写入失败不阻断已成功的网络响应',async()=>{
 const h=createSW();h.caches.failPut=true;h.setFetch(async()=>new Response('FRESH'));
 assert.equal(await(await h.dispatch('fetch',{request:h.request('backup.js?v=2.2.2')})).text(),'FRESH');
});
test('安装的全部19资源存在并用reload预缓存；云SDK失败不阻止安装',async()=>{
 const h=createSW();const assets=Array.from(h.run('CORE_ASSETS'));assert.equal(assets.length,19);
 for(const asset of assets){const rel=asset.replace(/^\.\//,'').split('?')[0]||'index.html';assert.ok(fs.existsSync(path.join(root,rel)),asset);}
 h.setFetch(async request=>{if(String(request.url||request).includes('cdn.jsdelivr.net'))throw new Error('no CDN');return new Response('OK');});
 await h.dispatch('install');assert.equal(h.counts().skipped,1);
 for(const call of h.calls.filter(c=>!String(c.url).includes('cdn.jsdelivr.net')))assert.equal(call.request.cache,'reload');
});
test('核心资源预缓存失败不激活新Worker，不删除旧离线缓存',async()=>{
 const h=createSW();await h.caches.open('cet6-review-v2.2.0-static-1');h.setFetch(async request=>new Response('bad',{status:404}));
 await assert.rejects(()=>h.dispatch('install'));assert.equal(h.counts().skipped,0);
 assert.ok((await h.caches.keys()).includes('cet6-review-v2.2.0-static-1'));
});
test('激活只清本项目前缀旧资源缓存，不触碰其他缓存或IndexedDB',async()=>{
 const h=createSW();await h.caches.open('other-app');await h.caches.open('cet6-review-v2.2.0-static-1');await h.caches.open(h.run('STATIC_CACHE'));
 await h.dispatch('activate');const keys=await h.caches.keys();assert.ok(keys.includes('other-app'));assert.ok(keys.includes(h.run('STATIC_CACHE')));assert.ok(!keys.includes('cet6-review-v2.2.0-static-1'));
 assert.equal(h.counts().claimed,1);assert.equal(h.messages[0].version,'2.2.2');
});
test('Supabase API与非GET不拦截缓存，版本查询返回2.2.2',async()=>{
 const h=createSW();assert.equal(await h.dispatch('fetch',{request:{url:'https://project.supabase.co/rest/v1/test',method:'GET',mode:'cors'}}),undefined);
 assert.equal(await h.dispatch('fetch',{request:{...h.request('app.js'),method:'POST'}}),undefined);
 let message;await h.dispatch('message',{data:{type:'CET6_GET_SW_VERSION'},ports:[{postMessage:m=>message=m}]});assert.equal(message.version,'2.2.2');
});
test('直接浏览其它文件不会污染离线首页缓存',async()=>{
 const h=createSW();const cache=await h.caches.open(h.run('STATIC_CACHE'));
 await cache.put(h.base+'index.html',new Response('HOME'));
 await h.dispatch('fetch',{request:h.request('tests/UI_v2.2.2_settings.png','navigate')});
 h.setFetch(async()=>{throw new Error('offline');});
 assert.equal(await(await h.dispatch('fetch',{request:h.request('?offline=1','navigate')})).text(),'HOME');
});
