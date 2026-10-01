const test=require('node:test');const assert=require('node:assert/strict');
const {createContext,clean,modernWord,session,word}=require('./support/harness.cjs');
async function cloud(){const h=createContext();await h.context.initReviewDB();h.context.uploadedRows=[];
 h.run(`state.signedIn=true; state.user={id:'test-user'}; state.client={from:()=>({upsert:async rows=>{uploadedRows.push(...rows); return {error:null};}})};`);return h;}

test('旧会话10月1/2日及更晚日期全部拒绝；9月30日允许迁移',()=>{
 const h=createContext();for(const date of ['2026-10-01','2026-10-02','2026-11-20']){
  assert.equal(h.context.upgradeLegacyRemoteRecord('dailySessions',{date,primaryCompleted:200}),null);
 }
 const old=h.context.upgradeLegacyRemoteRecord('dailySessions',{date:'2026-09-30',primaryCompleted:200});
 assert.equal(old.primaryCompleted,200);assert.equal(old.schedulerVersion,2);
 assert.equal(h.context.upgradeLegacyRemoteRecord('dailySessions',{remoteId:'2026-10-20'}),null);
 assert.equal(h.context.upgradeLegacyRemoteRecord('dailySessions',{}),null);
});
test('所有日期的v2会话原样接受，不误伤边界日新记录',()=>{
 const h=createContext();for(const date of ['2026-10-01','2026-10-02','2026-11-20']){
  const record=session(date);assert.deepEqual(clean(h.context.upgradeLegacyRemoteRecord('dailySessions',record)),record);
 }
});
test('真正v2记录优先于旧版虚高revision；双方v2时按revision选择',()=>{
 const h=createContext();const newRecord=session('2026-09-30',{stateRevision:3});
 const oldRecord={date:'2026-09-30',stateRevision:999999,primaryCompleted:200,updatedAt:'2099-01-01T00:00:00Z'};
 assert.deepEqual(clean(h.context.mergeDailySessionRecords(newRecord,oldRecord)),newRecord);
 assert.deepEqual(clean(h.context.mergeDailySessionRecords(oldRecord,newRecord)),newRecord);
 const w=modernWord(1,{stateRevision:3});
 const oldWord={id:w.id,lastReviewedAt:'2026-09-30T04:00:00Z',lastRating:'know',stateRevision:99999};
 assert.deepEqual(clean(h.context.mergeWordProgressRecords(w,oldWord)),w);
 assert.equal(h.context.mergeDailySessionRecords(session('2026-10-02',{stateRevision:4}),session('2026-10-02',{stateRevision:9})).stateRevision,9);
});
test('旧wordProgress同样按边界拦截，历史记录允许升级',()=>{
 const h=createContext();assert.equal(h.context.upgradeLegacyRemoteRecord('wordProgress',{id:'a',lastReviewedDate:'2026-10-02'}),null);
 const w=h.context.upgradeLegacyRemoteRecord('wordProgress',{id:'a',lastReviewedDate:'2026-09-30',lastReviewedAt:'2026-09-30T04:00:00Z',lastRating:'know'});
 assert.equal(w.roundCount,1);assert.equal(w.remediationActive,false);
});
test('远端独有旧会话不能落库，远端独有v2正常恢复',async()=>{
 const h=await cloud();const remote=[{date:'2026-10-02',primaryCompleted:200},session('2026-10-03')];
 const result=await h.context.mergeStore('dailySessions',[],remote);
 assert.equal(result.downloaded,1);assert.equal(await h.context.getDailySession('2026-10-02'),null);
 assert.equal((await h.context.getDailySession('2026-10-03')).primaryCompleted,1);
});
test('本地独有旧会话也不能上传，双方皆旧时不写入null',async()=>{
 const h=await cloud();const old={date:'2026-10-02',primaryCompleted:200};
 const onlyLocal=await h.context.mergeStore('dailySessions',[old],[]);assert.equal(onlyLocal.uploaded,0);
 const both=await h.context.mergeStore('dailySessions',[old],[{...old,updatedAt:'2026-10-03'}]);
 assert.equal(both.uploaded,0);assert.equal(both.downloaded,0);assert.equal(h.context.uploadedRows.length,0);
 assert.throws(()=>h.context.buildRow('dailySessions',old));
 const push=await h.context.pushRecord('dailySessions',old,{checkRemote:false});assert.equal(push.uploaded,0);
});
test('本地v2与远端边界日旧会话冲突时本地保持，回写新版',async()=>{
 const h=await cloud();const valid=session('2026-10-02');await h.context.saveDailySession(valid,{fromCloud:true});
 const result=await h.context.mergeStore('dailySessions',[valid],[{date:'2026-10-02',primaryCompleted:200}]);
 assert.equal(result.downloaded,0);assert.equal(result.uploaded,1);
 assert.deepEqual(clean((await h.context.getDailySession(valid.date))),valid);
 assert.equal(h.context.uploadedRows[0].payload.schedulerVersion,2);
});
test('旧历史会话仍能同步，并保留认识/遗忘原记录',async()=>{
 const h=await cloud();const history={date:'2026-09-30',primaryCompleted:200,know:160,forgot:40,primaryRatings:{w0001:'know'}};
 const result=await h.context.mergeStore('dailySessions',[],[history]);
 assert.equal(result.downloaded,1);assert.equal(result.uploaded,1);
 assert.equal((await h.context.getDailySession(history.date)).primaryCompleted,200);
 assert.deepEqual(clean((await h.context.getDailySession(history.date)).primaryRatings),history.primaryRatings);
});
