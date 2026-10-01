const test=require('node:test');
const assert=require('node:assert/strict');
const {createContext,clean,word,modernWord}=require('./support/harness.cjs');
const vocab=Array.from({length:1000},(_,i)=>word(i+1));

test('160 认识 + 40 遗忘：次日40个到期词加160个新词，无认识词回流',()=>{
 const h=createContext(['scheduler.js']);
 const records=vocab.slice(0,200).map((w,i)=>modernWord(i+1,i<160?{}:{lastRating:'forgot',remediationActive:true,nextReviewDate:'2026-10-01',reviewStage:0}));
 const p=h.context.buildDailyPrimaryQueue(vocab,records,200,'2026-10-01');
 assert.equal(p.items.length,200);assert.equal(p.meta.forgottenDue,40);assert.equal(p.meta.newAdded,160);
 assert.equal(p.items.filter(i=>i.type==='review').length,40);
 assert.ok(p.items.every(i=>!vocab.slice(0,160).some(w=>w.id===i.id)));
 assert.equal(new Set(p.items.map(i=>i.id)).size,200);
});
test('237个到期遗忘词全部进入，不增加新词',()=>{
 const h=createContext(['scheduler.js']);
 const records=vocab.slice(0,237).map((w,i)=>modernWord(i+1,{remediationActive:true,nextReviewDate:'2026-10-01'}));
 const p=h.context.buildDailyPrimaryQueue(vocab,records,200,'2026-10-01');
 assert.equal(p.items.length,237);assert.equal(p.meta.newAdded,0);assert.equal(p.meta.overflowBecauseForgotten,true);
 assert.ok(p.items.every(i=>i.type==='review'));
});
test('恰好200个遗忘词时不加新词，未到期强化词不混入普通轮次',()=>{
 const h=createContext(['scheduler.js']);
 const records=vocab.slice(0,201).map((w,i)=>modernWord(i+1,{remediationActive:true,nextReviewDate:i===200?'2026-10-20':'2026-10-01'}));
 const p=h.context.buildDailyPrimaryQueue(vocab,records,200,'2026-10-01');
 assert.equal(p.items.length,200);assert.equal(p.meta.newAdded,0);assert.ok(!p.items.some(i=>i.id===word(201).id));
});
test('整本当前轮完成才开第二轮；强化链未到期的词不重复加入',()=>{
 const h=createContext(['scheduler.js']);
 const small=vocab.slice(0,3);const records=small.map((w,i)=>modernWord(i+1));
 assert.equal(h.context.buildDailyPrimaryQueue(small,records.slice(0,2),200,'2026-10-01').meta.currentRound,1);
 records[2].remediationActive=true;records[2].nextReviewDate='2026-10-20';
 const p=h.context.buildDailyPrimaryQueue(small,records,200,'2026-10-01');
 assert.equal(p.meta.currentRound,2);assert.equal(p.items.length,2);
});
test('当天递增10/25/50/队尾，序列化恢复后仍延续层级',()=>{
 const h=createContext(['scheduler.js']);let q=vocab.slice(0,300).map(w=>({id:w.id,type:'primary'}));let cursor=0;
 for(const [n,gap] of [10,25,50,'tail'].entries()){
  const beforeLength=q.length;
  const index=h.context.insertReinforcement(q,cursor,q[cursor].id);
  assert.equal(index,gap==='tail'?beforeLength:cursor+1+gap);
  assert.equal(q[index].reinforcementLevel,n+1);assert.equal(q[index].scheduledGap,gap);
  q=clean(q);cursor=index;
 }
 const index=h.context.insertReinforcement(q,cursor,q[cursor].id);
 assert.equal(index,q.length-1);assert.equal(q[index].reinforcementLevel,5);
});
test('旧版无层级加练队列兼容，下次遗忘使用25而非再次10',()=>{
 const h=createContext(['scheduler.js']);const q=vocab.slice(0,100).map(w=>({id:w.id,type:'primary'}));
 q.splice(11,0,{id:word(1).id,type:'reinforcement'});
 const index=h.context.insertReinforcement(q,11,word(1).id);
 assert.equal(index,37);assert.equal(q[index].scheduledGap,25);
});
test('短队列放队尾；剔除同词待做加练重复项，不改变正式任务数量',()=>{
 const h=createContext(['scheduler.js']);const q=[{id:'a',type:'primary'},{id:'a',type:'reinforcement'},{id:'b',type:'primary'},{id:'a',type:'reinforcement'}];
 const index=h.context.insertReinforcement(q,0,'a');
 assert.equal(index,2);assert.equal(q.filter(i=>i.type==='reinforcement').length,1);assert.equal(q.filter(i=>i.type==='primary').length,2);
 assert.throws(()=>h.context.insertReinforcement(q,3,'a'));
});
test('跨天阶梯1→3→7→14→30，成功完成30天阶段后退出强化链',()=>{
 const h=createContext(['scheduler.js','db.js']);const r=h.context.emptySchedulerV2Record(word(1));
 h.context.applyPlannedRating(r,'forgot','primary','2026-10-01','2026-10-01T00:00:00Z');
 assert.equal(r.nextReviewDate,'2026-10-02');
 for(const [today,next] of [['2026-10-02','2026-10-05'],['2026-10-05','2026-10-12'],['2026-10-12','2026-10-26'],['2026-10-26','2026-11-25']]){
  h.context.applyPlannedRating(r,'know','review',today,`${today}T00:00:00Z`);assert.equal(r.nextReviewDate,next);
 }
 h.context.applyPlannedRating(r,'know','review','2026-11-25','2026-11-25T00:00:00Z');
 assert.equal(r.remediationActive,false);assert.equal(r.nextReviewDate,null);assert.equal(r.roundCount,1);
});
test('跨天再忘记重回+1天；当天加练不推进跨天阶段',async()=>{
 const h=createContext();await h.context.initReviewDB();const r=modernWord(1,{remediationActive:true,reviewStage:3,nextReviewDate:'2026-10-01'});
 h.context.applyPlannedRating(r,'forgot','review','2026-10-01','2026-10-01T00:00:00Z');
 assert.equal(r.nextReviewDate,'2026-10-02');assert.equal(r.reviewStage,0);
 await h.context.putWordRecord(r,{fromCloud:true});await h.context.saveReinforcementAttempt(word(1),'know');
 const saved=await h.context.getWordProgress(r.id);assert.equal(saved.nextReviewDate,'2026-10-02');assert.equal(saved.reviewStage,0);assert.equal(saved.roundCount,1);
});
