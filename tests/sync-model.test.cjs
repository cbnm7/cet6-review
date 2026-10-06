const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../sync-model.js');
const M = globalThis.ReadingWordsModel;
const t0 = '2026-10-01T00:00:00.000Z', t1 = '2026-10-02T00:00:00.000Z', t2 = '2026-10-03T00:00:00.000Z';
const base = () => M.cleanWord({term:'attribute', meaning:'归因', source:'原来源', note:'旧备注', sentence:'An old sentence.', occurrenceCount:4, createdAt:t0, updatedAt:t0});
const patch = (fields, actor='A', at=t1, word=base()) => M.patchWord(word, fields, actor, at);
const dead = at => M.deletedState({normalizedTerm:'attribute', deletedAt:at});
test('normalizedTerm folds whitespace and case', () => assert.equal(M.normalize('  Look   UP  '), 'look up'));
test('legacy contents preserved', () => assert.equal(base().note, '旧备注'));
test('legacy empty fields do not erase older nonempty data', () => {
  const empty = M.cleanWord({term:'attribute', updatedAt:t2});
  assert.equal(M.mergeWords(base(),empty).meaning,'归因');
});
test('explicit clearing note survives older nonempty record', () => assert.equal(M.mergeWords(patch({note:''}),base()).note,''));
test('clearing all optional fields is valid', () => {
  const result = M.mergeWords(patch({meaning:'',source:'',sentence:'',note:''}),base());
  for(const f of ['meaning','source','sentence','note']) assert.equal(result[f],'');
});
test('new meaning and new note from independent devices both survive', () => {
  const result = M.mergeWords(patch({meaning:'新释义'}), patch({note:'新备注'},'B',t2));
  assert.equal(result.meaning,'新释义'); assert.equal(result.note,'新备注');
});
test('clearing one field and editing another both survive', () => {
  const result = M.mergeWords(patch({note:''}),patch({source:'新来源'},'B',t2));
  assert.equal(result.note,''); assert.equal(result.source,'新来源');
});
test('later version wins same-field edit', () => assert.equal(M.mergeWords(patch({note:'A'}),patch({note:'B'},'B',t2)).note,'B'));
test('equal timestamp deterministic tie independent of merge direction', () => {
  const a=patch({note:'A'},'A'), b=patch({note:'B'},'B');
  assert.deepEqual(M.mergeWords(a,b),M.mergeWords(b,a)); assert.equal(M.mergeWords(a,b).note,'B');
});
test('legacy exact-timestamp tie deterministic', () => {
  const a={term:'x',note:'A',updatedAt:t0}, b={term:'x',note:'B',updatedAt:t0};
  assert.deepEqual(M.mergeWords(a,b),M.mergeWords(b,a));
});
test('merge is idempotent', () => assert.deepEqual(M.mergeWords(base(),base()),base()));
test('independent field merge is associative', () => {
  const a=patch({meaning:'a'}),b=patch({note:'b'},'B'),c=patch({source:'c'},'C');
  assert.deepEqual(M.mergeWords(M.mergeWords(a,b),c),M.mergeWords(a,M.mergeWords(b,c)));
});
test('editing does not increment occurrenceCount', () => assert.equal(patch({note:'new'}).occurrenceCount,4));
test('merge does not multiply occurrenceCount', () => assert.equal(M.mergeWords(base(),base()).occurrenceCount,4));
test('createdAt preserved by ordinary edit', () => assert.equal(patch({note:'new'}).createdAt,t0));
test('term casing edit keeps normalized key', () => assert.equal(patch({term:'Attribute'}).normalizedTerm,'attribute'));
test('empty term rejected', () => assert.throws(()=>patch({term:' '}), /请输入/));
test('different keys cannot silently merge', () => assert.throws(()=>M.mergeWords(base(),{term:'mirror'}),/不同词条/));
test('deleted word beats stale edit made later on offline device', () => {
  assert.equal(M.mergeStates(M.wordState(patch({note:'offline'},'B',t2)),dead(t1)).kind,'deleted');
});
test('delete wins simultaneous create', () => assert.equal(M.mergeStates(M.wordState(base()),dead(t0)).kind,'deleted'));
test('newer deletion wins', () => assert.equal(M.mergeStates(dead(t0),dead(t1)).tombstone.deletedAt,t1));
test('explicit re-add after known deletion survives', () => {
  const word={...base(),createdAt:t2,updatedAt:t2,generationAt:t2,restoredAfter:t1};
  assert.equal(M.mergeStates(M.wordState(word),dead(t1)).kind,'word');
});
test('subsequent delete also deletes a re-added word', () => {
  const word={...base(),generationAt:t1,updatedAt:t1,restoredAfter:t0};
  assert.equal(M.mergeStates(M.wordState(word),dead(t2)).kind,'deleted');
});
test('old content is not filled into intentionally re-added blank word', () => {
  const fresh=M.cleanWord({term:'attribute',createdAt:t2,updatedAt:t2,generationAt:t2,restoredAfter:t1});
  const result=M.mergeWords(fresh,base()); assert.equal(result.note,''); assert.equal(result.meaning,'');
});
test('syncToken is transport-only and cannot leak into comparison', () => {
  assert.deepEqual(M.cleanWord({...base(),syncToken:'x'}),M.cleanWord({...base(),syncToken:'y'}));
});
test('local IDs never uploaded as identity', () => assert.equal(M.cleanWord({...base(),id:42}).id,undefined));
test('next local clock strictly later than observed future timestamp', () => {
  const future='2099-01-01T00:00:00.000Z'; assert.ok(M.time(M.nextTime({updatedAt:future}))>M.time(future));
});
test('null state merge preserves real state', () => assert.deepEqual(M.mergeStates(null,M.wordState(base())),M.wordState(base())));
test('tombstone carries no word content', () => {
  const d=M.cleanTombstone({...base(),deletedAt:t1}); assert.equal(d.note,undefined); assert.equal(d.meaning,undefined);
});
test('all editable fields have independent versions', () => assert.deepEqual(Object.keys(base().fieldVersions),M.FIELDS));
