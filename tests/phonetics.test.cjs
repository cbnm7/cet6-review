const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const vocab=JSON.parse(fs.readFileSync(path.join(ROOT,'data/cet6_2003.json'),'utf8'));
const dict=JSON.parse(fs.readFileSync(path.join(ROOT,'data/concise-dictionary.json'),'utf8'));

test('2003条词库稳定ID/顺序不变，纠正attribute与mirror词头',()=>{
  assert.equal(vocab.entries.length,2003);
  const ids=vocab.entries.map(x=>x.id);
  assert.equal(new Set(ids).size,2003);
  assert.equal(vocab.entries.find(x=>x.id==='cet6_0310').term,'attribute');
  assert.equal(vocab.entries.find(x=>x.id==='cet6_0367').term,'mirror');
  assert.equal(vocab.entries.find(x=>x.id==='cet6_0310').source_order,310);
  assert.equal(vocab.entries.find(x=>x.id==='cet6_0367').source_order,367);
  assert.equal(vocab.entries.some(x=>x.term==='a tribute'||x.term==='mir'||x.term==='atribute'),false);
});

test('1992个唯一词头全部有北美英语IPA且与核心词表完全覆盖',()=>{
  assert.equal(dict.version,'2.2.2-concise-ipa-1');
  assert.equal(dict.entries.length,1992);
  assert.equal(dict.phoneticCoverageCount,1992);
  const unique=new Set(vocab.entries.map(x=>x.term.trim().toLowerCase()));
  assert.equal(unique.size,1992);
  assert.deepEqual(new Set(dict.entries.map(x=>x.term.trim().toLowerCase())),unique);
  for(const row of dict.entries){
    assert.equal(typeof row.us,'string',row.term);
    assert.ok(row.us.trim().length>0,row.term);
    assert.equal(/[0-9*]/.test(row.us),false,`${row.term}: ${row.us}`);
  }
});

test('重点词头音标与释义已同步',()=>{
  const m=new Map(dict.entries.map(x=>[x.term,x]));
  assert.equal(m.get('attribute').us,'ˈætrəbˌjut');
  assert.equal(m.get('mirror').us,'ˈmɪrɚ');
  assert.deepEqual(m.get('attribute').translations.map(x=>x.type),['n.','v.']);
  assert.deepEqual(m.get('mirror').translations.map(x=>x.type),['n.','v.']);
});

test('学习数据库版本和名称保持不变，词头修正不会更换进度主键',()=>{
  const db=fs.readFileSync(path.join(ROOT,'db.js'),'utf8');
  assert.match(db,/const DB_NAME = "cet6-review-db";/);
  assert.match(db,/const DB_VERSION = 4;/);
  assert.match(db,/createObjectStore\(WORD_STORE, \{ keyPath: "id" \}\)/);
});
