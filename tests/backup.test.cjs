const test=require('node:test');const assert=require('node:assert/strict');
const {createContext,clean,word,modernWord,session,backup,file}=require('./support/harness.cjs');
async function initialized(){const h=createContext();await h.context.initReviewDB();return h;}
function stableStores(stores){return Object.fromEntries(Object.entries(clean(stores)).map(([k,v])=>[k,v.sort((a,b)=>String(a.id??a.date).localeCompare(String(b.id??b.date)))]));}

test('v2.2.0 schema1备份导入：10月1日/15日/20日新版真实记录逐字段保留',async()=>{
 const h=await initialized();
 const b=backup({wordProgress:[modernWord(1)],dailySessions:[session('2026-10-01'),session('2026-10-15'),session('2026-10-20')],readingWords:[{id:1,term:'hello',normalizedTerm:'hello',note:'保留原句'}]});
 const result=await h.context.importStudyBackupFile(file(b));
 assert.equal(result.restoreSummary.migratedLegacy,false);
 assert.deepEqual(stableStores((await h.context.buildStudyBackup()).stores),stableStores(b.stores));
 assert.equal(await h.context.migrateSchedulerV2IfNeeded(),false);
 assert.deepEqual(stableStores((await h.context.buildStudyBackup()).stores),stableStores(b.stores));
});
test('v2.2.2备份往返和重复导入不清正常进度；包含迁移标记',async()=>{
 const h=await initialized();const b=backup({wordProgress:[modernWord(1)],dailySessions:[session('2026-10-20')]});
 await h.context.importStudyBackupFile(file(b));const exported=await h.context.buildStudyBackup();
 assert.equal(exported.schemaVersion,2);assert.equal(exported.appVersion,'2.2.2');assert.equal(exported.scheduler.version,2);assert.equal(exported.scheduler.migration.version,2);
 for(let i=0;i<3;i++){
  await h.context.importStudyBackupFile(file(exported));
  assert.deepEqual(stableStores((await h.context.buildStudyBackup()).stores),stableStores(b.stores));
  assert.equal(await h.context.migrateSchedulerV2IfNeeded(),false);
 }
});
test('旧备份恢复昨日真实结果，舍弃边界日起的旧会话，重生成当日任务',async()=>{
 const h=await initialized();const old={id:word(1).id,reviewCount:2,knowCount:1,forgotCount:1,lastRating:'forgot',lastReviewedAt:'2026-10-01T04:00:00Z'};
 const b=backup({wordProgress:[old,{...old,id:word(2).id},{...old,id:word(3).id}],dailySessions:[
  {date:'2026-09-30',primaryRatings:{[word(1).id]:'know',[word(2).id]:'forgot'},primaryCompleted:2,updatedAt:'2026-09-30T04:00:00Z'},
  {date:'2026-10-01',queue:[],primaryCompleted:1,primaryRatings:{[word(1).id]:'forgot'}},
  {date:'2026-10-02',primaryCompleted:200}
 ],dailyStats:[{date:'2026-09-30',total:200},{date:'2026-10-01',total:99}]},{appVersion:'2.1.3'});
 const result=await h.context.importStudyBackupFile(file(b));assert.equal(result.restoreSummary.migratedLegacy,true);
 const w1=await h.context.getWordProgress(word(1).id),w2=await h.context.getWordProgress(word(2).id),w3=await h.context.getWordProgress(word(3).id);
 assert.equal(w1.lastRating,'know');assert.equal(w1.roundCount,1);assert.equal(w1.nextReviewDate,null);
 assert.equal(w2.lastRating,'forgot');assert.equal(w2.nextReviewDate,'2026-10-01');assert.equal(w3.roundCount,0);
 assert.equal((await h.context.getDailySession('2026-10-01')).needsRegeneration,true);
 assert.equal(await h.context.getDailySession('2026-10-02'),null);
 assert.equal((await h.context.getStoreAll('dailyStats')).length,1);
 const v=Array.from({length:300},(_,i)=>word(i+1));
 const plan=h.context.buildDailyPrimaryQueue(v,await h.context.getAllWordProgress(),200,'2026-10-01');
 assert.equal(plan.items.length,200);assert.equal(plan.items[0].id,word(2).id);assert.ok(!plan.items.some(i=>i.id===word(1).id));
});
test('混合备份：只迁移旧记录，不回退现有v2词和10月1日新版会话',async()=>{
 const h=await initialized();const modern=modernWord(2);const s=session('2026-10-01');
 const b=backup({wordProgress:[{id:word(1).id,lastRating:'know',reviewCount:1,lastReviewedAt:'2026-09-30T04:00:00Z'},modern],dailySessions:[s]},{appVersion:'2.1.3'});
 await h.context.importStudyBackupFile(file(b));
 assert.deepEqual(clean(await h.context.getWordProgress(modern.id)),modern);assert.deepEqual(clean(await h.context.getDailySession(s.date)),s);
});
test('启动标记缺失时也不破坏已有v2记录，空安装不制造历史日期',async()=>{
 const h=await initialized();assert.equal((await h.context.getAllDailySessions()).length,0);
 const b=backup({wordProgress:[modernWord(1)],dailySessions:[session('2026-10-15')]});
 await h.context.replaceStudyStores(b.stores);
 await h.context.putMetaRecord({key:'scheduler-v2-migration',version:0});
 await h.context.migrateSchedulerV2IfNeeded();
 assert.deepEqual(clean(await h.context.getAllWordProgress()),b.stores.wordProgress);
 assert.deepEqual(clean(await h.context.getAllDailySessions()),b.stores.dailySessions);
});
test('首次旧迁移保留原始快照，后续迁移不覆盖最早快照',async()=>{
 const h=await initialized();const old=backup({wordProgress:[{id:word(1).id,lastReviewedAt:'2026-09-30T04:00:00Z',lastRating:'know'}],dailySessions:[]},{appVersion:'2.1.3'});
 await h.context.replaceStudyStores(old.stores);await h.context.putMetaRecord({key:'scheduler-v2-migration',version:0});await h.context.migrateSchedulerV2IfNeeded();
 const snap=clean(await h.context.getMetaRecord('scheduler-v2-pre-migration-backup'));
 await h.context.putMetaRecord({key:'scheduler-v2-migration',version:0});await h.context.migrateSchedulerV2IfNeeded();
 assert.deepEqual(clean(await h.context.getMetaRecord('scheduler-v2-pre-migration-backup')),snap);
});
test('成功导入自动保留导入前快照，并暂停自动同步等待核对',async()=>{
 const h=await initialized();const b=backup({wordProgress:[modernWord(1)],dailySessions:[session('2026-10-15')]});
 await h.context.importStudyBackupFile(file(b));const next=backup({wordProgress:[modernWord(2)],dailySessions:[]});
 await h.context.importStudyBackupFile(file(next));
 const snapshot=await h.context.getMetaRecord('study-backup-before-import');
 assert.deepEqual(stableStores(snapshot.backup.stores),stableStores(b.stores));
 assert.equal(h.context.CET6Cloud.getStatus().restoreSyncPaused,true);assert.equal(h.storage.get('cet6-cloud-restore-paused'),'1');
 const skipped=await h.context.CET6Cloud.syncNow({reason:'timer'});assert.equal(skipped.skipped,true);
});
test('不支持/损坏/缺主键/重复主键备份在写入前拒绝，原数据不变',async()=>{
 const h=await initialized();const base=backup({wordProgress:[modernWord(1)],dailySessions:[session('2026-10-15')]});await h.context.importStudyBackupFile(file(base));
 const cases=[{text:async()=>'{broken'},file({...base,schemaVersion:999}),file({...base,stores:{}}),
 file(backup({wordProgress:[{}]})),file(backup({wordProgress:[modernWord(1),modernWord(1)]})),
 file(backup({wordProgress:[modernWord(2,{schedulerVersion:99})]})),file(backup({dailySessions:[session('2026-13-01')]}))];
 for(const bad of cases){await assert.rejects(()=>h.context.importStudyBackupFile(bad));assert.deepEqual(stableStores((await h.context.buildStudyBackup()).stores),stableStores(base.stores));}
});
test('事务中途写入失败整体回滚，数据/迁移标记/导入前快照均不被部分替换',async()=>{
 const h=await initialized();const b=backup({wordProgress:[modernWord(1)],dailySessions:[session('2026-10-15')]});await h.context.importStudyBackupFile(file(b));
 const snap=clean(await h.context.getMetaRecord('study-backup-before-import'));
 const marker=clean(await h.context.getMetaRecord('scheduler-v2-migration'));
 h.idb.failNextPutStore='dailySessions';
 await assert.rejects(()=>h.context.importStudyBackupFile(file(backup({wordProgress:[modernWord(2)],dailySessions:[session('2026-10-20')]}))));
 assert.deepEqual(stableStores((await h.context.buildStudyBackup()).stores),stableStores(b.stores));
 assert.deepEqual(clean(await h.context.getMetaRecord('study-backup-before-import')),snap);
 assert.deepEqual(clean(await h.context.getMetaRecord('scheduler-v2-migration')),marker);
});
test('同步中的写入先结束，再取得导入前快照',async()=>{
 const h=await initialized();let resolvePending;
 h.run('state.syncPromise = new Promise(resolve => { globalThis.resolvePendingRestore = resolve; })');
 const pending=h.context.importStudyBackupFile(file(backup({wordProgress:[modernWord(2)]})));
 await new Promise(r=>setTimeout(r,5));
 assert.equal(h.context.CET6Cloud.getStatus().dataRestoreInProgress,true);
 await h.context.putWordRecord(modernWord(1),{fromCloud:true});h.context.resolvePendingRestore();
 await pending;
 assert.equal((await h.context.getMetaRecord('study-backup-before-import')).backup.stores.wordProgress[0].id,word(1).id);
});
