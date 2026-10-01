const test=require('node:test'),assert=require('node:assert/strict');
const {createContext}=require('./support/harness.cjs');
test('更新提示只接受更高版本，不把旧Worker当作新版',()=>{
 const h=createContext(['pwa.js']);
 for(const version of ['2.2.0','2.2.1','invalid'])assert.equal(h.context.isNewerAppVersion(version),false);
 for(const version of ['2.2.2','2.3.0','2.10.0','3.0.0'])assert.equal(h.context.isNewerAppVersion(version),true);
});
