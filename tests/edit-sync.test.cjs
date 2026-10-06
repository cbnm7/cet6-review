const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Backend,device,clone,delay}=require('./support/sync-harness.cjs');
const pair=async()=>{const backend=new Backend(),a=await device(backend),b=await device(backend);await a.login();await b.login();return {backend,a,b};};
const seed=async(a,b)=>{await a.add({term:'attribute',meaning:'归因',source:'阅读',note:'旧备注'});await a.sync();await b.sync();};

test('upgrade: same database/version and no data reset',async()=>{
  const d=await device();assert.equal(d.run('readingDB.name'),'cet6-review-db');assert.equal(d.run('readingDB.version'),5);
  const legacy={id:42,term:'old',normalizedTerm:'old',meaning:'旧词',occurrenceCount:7,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-02T00:00:00.000Z'};
  d.ctx.indexedDB.databases.get('cet6-review-db').stores.get('readingWords').data.set(42,clone(legacy));
  const reopened=await device(new Backend(),d.ctx.indexedDB);
  assert.deepEqual(await reopened.word('old'),legacy);
});
test('edit keeps local ID creation time count and total count',async()=>{
  const d=await device(),old=await d.add({term:'word',meaning:'原义'});const edited=await d.edit('word',{meaning:'新义'});
  for(const field of ['id','createdAt','occurrenceCount'])assert.equal(edited[field],old[field]);
  assert.equal((await d.words()).length,1);
});
test('all five fields editable, optional fields can be blank',async()=>{
  const d=await device();await d.add({term:'word',meaning:'a',source:'b',sentence:'c',note:'d'});
  const w=await d.edit('word',{term:'words',meaning:'',source:'',sentence:'',note:''});
  for(const f of ['meaning','source','sentence','note'])assert.equal(w[f],'');assert.equal(w.term,'words');
});
test('normal save retains encounter behavior and edit does not',async()=>{
  const d=await device();await d.add({term:'Word',meaning:'a'});await d.add({term:' word ',note:'b'});await d.edit('word',{source:'c'});
  const w=await d.word('word');assert.equal(w.occurrenceCount,2);assert.equal(w.meaning,'a');assert.equal(w.note,'b');
});
test('rename writes old-key tombstone and new key atomically',async()=>{
  const d=await device(),old=await d.add({term:'atribute'});const w=await d.edit('atribute',{term:'attribute'});
  assert.equal(w.id,old.id);assert.equal(await d.word('atribute'),null);assert.equal((await d.snapshot()).tombstones[0].normalizedTerm,'atribute');
});
test('rename collision fails with both words intact',async()=>{
  const d=await device();await d.add({term:'a'});await d.add({term:'b'});
  await assert.rejects(d.edit('a',{term:' B '}),{code:'TERM_EXISTS'});assert.equal((await d.words()).length,2);assert.equal((await d.snapshot()).tombstones.length,0);
});
test('case-only edit does not create deletion tombstone',async()=>{
  const d=await device();await d.add({term:'word'});await d.edit('word',{term:'Word'});assert.equal((await d.snapshot()).tombstones.length,0);
});
test('transaction failure rolls back rename and tombstone',async()=>{
  const d=await device(),old=await d.add({term:'a'});d.ctx.indexedDB.failNextPutStore='readingWords';
  await assert.rejects(d.edit('a',{term:'b'}),/InjectedQuota/);
  assert.deepEqual(await d.word('a'),old);assert.equal(await d.word('b'),null);assert.equal((await d.snapshot()).tombstones.length,0);
});
test('editing a deleted entry fails rather than resurrecting it',async()=>{
  const d=await device(),old=await d.add({term:'a'});await d.delete('a');d.ctx.savedBase=old;
  await assert.rejects(d.run('updateReadingWord(savedBase.id,{note:"draft"},{base:savedBase})'),{code:'WORD_GONE'});
});
test('login merges existing unique words from two devices',async()=>{
  const {a,b}=await pair();await a.add({term:'a'});await b.add({term:'b'});await a.sync();await b.sync();await a.sync();
  assert.deepEqual((await a.words()).map(w=>w.term).sort(),['a','b']);assert.equal((await b.words()).length,2);
});
test('editing content synchronizes both directions',async()=>{
  const {a,b}=await pair();await seed(a,b);await a.edit('attribute',{meaning:'A edit'});await a.sync();await b.sync();assert.equal((await b.word('attribute')).meaning,'A edit');
  await b.edit('attribute',{note:'B edit'});await b.sync();await a.sync();assert.equal((await a.word('attribute')).note,'B edit');
});
test('clearing fields is synced and not filled by old data',async()=>{
  const {a,b}=await pair();await seed(a,b);await b.edit('attribute',{meaning:'',note:''});await b.sync();await a.sync();await b.sync();
  assert.equal((await a.word('attribute')).note,'');assert.equal((await a.word('attribute')).meaning,'');
});
test('disjoint offline field edits both survive',async()=>{
  const {a,b}=await pair();await seed(a,b);await a.edit('attribute',{meaning:'from A'});await b.edit('attribute',{note:'from B'});
  await a.sync();await b.sync();await a.sync();const w=await a.word('attribute');assert.equal(w.meaning,'from A');assert.equal(w.note,'from B');
});
test('same field conflict resolves identically on both devices',async()=>{
  const {a,b}=await pair();await seed(a,b);await a.edit('attribute',{note:'A'});await new Promise(r=>setTimeout(r,3));await b.edit('attribute',{note:'B'});
  await a.sync();await b.sync();await a.sync();assert.equal((await a.word('attribute')).note,'B');assert.equal((await b.word('attribute')).note,'B');
});
test('simultaneous cloud updates use CAS and merge instead of blind overwrite',async()=>{
  const {a,b,backend}=await pair();await seed(a,b);await a.edit('attribute',{meaning:'A'});await b.edit('attribute',{note:'B'});
  let release,arrived=0;const barrier=new Promise(r=>{release=r;});
  backend.beforeWrite=async()=>{if(++arrived<=2){if(arrived===2)release();await barrier;}};
  await Promise.all([a.sync(),b.sync()]);backend.beforeWrite=null;await a.sync();await b.sync();
  assert.ok(backend.casConflicts>=1);assert.equal((await a.word('attribute')).meaning,'A');assert.equal((await b.word('attribute')).note,'B');
});
test('simultaneous initial inserts retry duplicate-key conflict',async()=>{
  const {a,b,backend}=await pair();await a.add({term:'a',meaning:'A'});await b.add({term:'a',note:'B'});
  let release,n=0;const wait=new Promise(r=>release=r);backend.beforeWrite=async()=>{if(++n<=2){if(n===2)release();await wait;}};
  await Promise.all([a.sync(),b.sync()]);backend.beforeWrite=null;await a.sync();assert.equal((await a.word('a')).note,'B');assert.equal((await a.word('a')).meaning,'A');
});
test('concurrent local edit during upload is not lost',async()=>{
  const {a,b,backend}=await pair();await seed(a,b);await a.edit('attribute',{note:'before'});
  let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
  backend.beforeWrite=async()=>{backend.beforeWrite=null;entered();await gate;};
  const pending=a.sync();await ready;await a.edit('attribute',{note:'during'});release();await pending;await b.sync();assert.equal((await b.word('attribute')).note,'during');
});
test('new word created during sync is uploaded in an extra pass',async()=>{
  const {a,b,backend}=await pair();await seed(a,b);await a.edit('attribute',{note:'pending'});
  let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
  backend.beforeWrite=async()=>{backend.beforeWrite=null;entered();await gate;};
  const pending=a.sync();await ready;await a.add({term:'new-during-sync'});release();await pending;await b.sync();assert.ok(await b.word('new-during-sync'));
});
test('network failure preserves edits for successful retry',async()=>{
  const {a,b,backend}=await pair();await seed(a,b);await a.edit('attribute',{note:'local'});backend.failNext=true;
  await assert.rejects(a.sync(), e=>e.message.includes('Simulated'));assert.equal((await a.word('attribute')).note,'local');await a.sync();await b.sync();assert.equal((await b.word('attribute')).note,'local');
});
test('rename synchronizes new key and deletes old key on other device',async()=>{
  const {a,b}=await pair();await seed(a,b);await a.edit('attribute',{term:'corrected attribute'});await a.sync();await b.sync();assert.equal(await b.word('attribute'),null);assert.ok(await b.word('corrected attribute'));
});
test('delete wins even if offline old copy was edited later',async()=>{
  const {a,b}=await pair();await seed(a,b);await a.delete('attribute');await b.edit('attribute',{note:'stale edit'});
  await a.sync();await b.sync();await a.sync();assert.equal(await b.word('attribute'),null);assert.equal(await a.word('attribute'),null);
});
test('deliberate re-add after delete syncs correctly',async()=>{
  const {a,b}=await pair();await seed(a,b);await a.delete('attribute');await a.sync();await b.sync();await b.add({term:'attribute',meaning:'re-added'});await b.sync();await a.sync();
  assert.equal((await a.word('attribute')).meaning,'re-added');assert.equal((await a.word('attribute')).note,'');
});
test('open edit base: untouched remote field is preserved',async()=>{
  const {a,b}=await pair();await seed(a,b);a.ctx.base=await a.word('attribute');await b.edit('attribute',{note:'remote'});await b.sync();await a.sync();
  await a.run('updateReadingWord(base.id,{meaning:"draft"},{base})');assert.equal((await a.word('attribute')).note,'remote');
});
test('open edit base: changed same field triggers explicit conflict',async()=>{
  const {a,b}=await pair();await seed(a,b);a.ctx.base=await a.word('attribute');await b.edit('attribute',{note:'remote'});await b.sync();await a.sync();
  await assert.rejects(a.run('updateReadingWord(base.id,{note:"draft"},{base})'),{code:'EDIT_CONFLICT'});assert.equal((await a.word('attribute')).note,'remote');
});
test('empty device does not wipe existing cloud data',async()=>{
  const {a,b}=await pair();await a.add({term:'persist'});await a.sync();await b.sync();assert.ok(await b.word('persist'));assert.ok(await a.word('persist'));
});
test('no-change sync is idempotent and does not upload',async()=>{
  const {a,b}=await pair();await seed(a,b);const before=await a.word('attribute');const r=await a.sync();assert.equal(r.uploaded,0);assert.deepEqual(await a.word('attribute'),before);
});
test('pagination downloads more than 1000 cloud words',async()=>{
  const backend=new Backend(),d=await device(backend);await d.login();
  for(let i=0;i<1105;i++){
    const term='page-'+i.toString().padStart(4,'0'),at='2026-01-01T00:00:00.000Z';
    const row={user_id:'reader@test.local',store_name:'readingWords',record_key:Buffer.from(term).toString('base64url'),payload:{term,normalizedTerm:term,createdAt:at,updatedAt:at},deleted:false,source_updated_at:at,updated_at:at};backend.rows.set(backend.key(row),row);
  }
  await d.sync();assert.equal((await d.words()).length,1105);assert.ok(backend.operations.filter(q=>q.op==='select').length>=3);
});
test('logout during remote request aborts application to local data',async()=>{
  const {a,b,backend}=await pair();await seed(a,b);await a.edit('attribute',{note:'new'});
  let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
  backend.beforeWrite=async()=>{backend.beforeWrite=null;entered();await gate;};const pending=a.sync();await ready;
  await a.run('rwLogout()');release();await assert.rejects(pending,/账号已变化/);assert.equal((await a.word('attribute')).note,'new');
});
test('cloud tombstone payload contains no deleted body',async()=>{
  const {a,b,backend}=await pair();await seed(a,b);await a.delete('attribute');await a.sync();const row=[...backend.rows.values()][0];
  assert.ok(row.deleted);assert.equal(row.payload.note,undefined);assert.equal(row.payload.meaning,undefined);
});
test('two overlapping local additions of same term remain one row',async()=>{
  const d=await device();await Promise.all([d.add({term:'word',meaning:'meaning'}),d.add({term:'WORD',note:'note'})]);
  const all=await d.words();assert.equal(all.length,1);assert.equal(all[0].occurrenceCount,2);assert.equal(all[0].meaning,'meaning');assert.equal(all[0].note,'note');
});
test('stale cloud download merges current local edit instead of overwriting it',async()=>{
  const d=await device(),original=await d.add({term:'word',note:'old'});await d.edit('word',{note:'new'});d.ctx.stale=original;
  await d.run('applyReadingStateFromCloud(ReadingWordsModel.wordState(stale))');assert.equal((await d.word('word')).note,'new');
});
test('delete during an in-flight upload is eventually sent as deletion',async()=>{
  const {a,b,backend}=await pair();await seed(a,b);await a.edit('attribute',{note:'upload'});
  let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
  backend.beforeWrite=async()=>{backend.beforeWrite=null;entered();await gate;};const pending=a.sync();await ready;
  await a.delete('attribute');release();await pending;await b.sync();assert.equal(await b.word('attribute'),null);
});
test('aborted edits emit no successful local-change event',async()=>{
  const d=await device();await d.add({term:'word'});let events=0;d.ctx.addEventListener('reading-words-local-change',()=>events++);
  d.ctx.indexedDB.failNextPutStore='readingWords';await assert.rejects(d.edit('word',{note:'new'}));assert.equal(events,0);
});
