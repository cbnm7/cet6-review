const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { MemoryIDB } = require('./memory-idb.cjs');
const clone = v => v == null ? v : structuredClone(v);
const delay = () => new Promise(resolve=>setImmediate(resolve));
class Backend {
  constructor(){this.rows=new Map();this.failNext=false;this.beforeWrite=null;this.casConflicts=0;this.operations=[];}
  key(row){return [row.user_id,row.store_name,row.record_key].join('|');}
  async execute(q, user){
    this.operations.push(clone(q));
    await delay();
    if(this.failNext){this.failNext=false;return {error:{message:'Simulated network failure'},data:null};}
    if(!user)return {error:{message:'not signed in'}};
    if(q.op!=='select'&&this.beforeWrite)await this.beforeWrite(q);
    const val=(row,field)=>field==='payload->>syncToken'?row.payload?.syncToken??null:row[field];
    const matches=row=>row.user_id===user.id&&q.filters.every(([op,f,v])=>op==='gt'?val(row,f)>v:val(row,f)===v);
    if(q.op==='select'){
      let rows=[...this.rows.values()].filter(matches);
      if(q.order)rows.sort((a,b)=>a[q.order]===b[q.order]?0:a[q.order]>b[q.order]?1:-1);
      rows=rows.slice(0,q.limit);
      return {data:clone(q.single?rows[0]||null:rows),error:null};
    }
    const row=clone(q.row),key=this.key(row);
    if(row.user_id!==user.id)return {error:{code:'42501',message:'permission denied'}};
    if(q.op==='insert'){
      if(this.rows.has(key))return {error:{code:'23505',message:'duplicate'}};
      this.rows.set(key,row);return {data:[clone(row)],error:null};
    }
    const old=this.rows.get(key);
    if(old&&matches(old)){this.rows.set(key,row);return {data:[clone(row)],error:null};}
    this.casConflicts++;return {data:[],error:null};
  }
}
function sdk(backend){
  let user=null, callback=()=>{};
  class Query{
    constructor(){this.q={op:'select',filters:[],limit:1000};}
    select(c){this.q.columns=c;return this;}
    eq(f,v){this.q.filters.push(['eq',f,v]);return this;}
    is(f,v){this.q.filters.push(['is',f,v]);return this;}
    gt(f,v){this.q.filters.push(['gt',f,v]);return this;}
    order(f){this.q.order=f;return this;}
    limit(n){this.q.limit=n;return this;}
    maybeSingle(){this.q.single=true;return this;}
    insert(row){this.q.op='insert';this.q.row=row;return this;}
    update(row){this.q.op='update';this.q.row=row;return this;}
    then(resolve,reject){return backend.execute(clone(this.q),clone(user)).then(resolve,reject);}
  }
  return {createClient:()=>({from:()=>new Query(),auth:{
    onAuthStateChange:cb=>{callback=cb;return {data:{subscription:{unsubscribe(){}}}};},
    getSession:async()=>({data:{session:user?{user}:null},error:null}),
    signInWithPassword:async({email})=>{user={id:email,email};callback('SIGNED_IN',{user});return {data:{user},error:null};},
    signUp:async({email})=>{user={id:email,email};callback('SIGNED_IN',{user});return {data:{user,session:{user}},error:null};},
    signOut:async()=>{user=null;callback('SIGNED_OUT',null);return {error:null};}
  }})};
}
async function device(backend=new Backend(), sharedDB=null){
  const events=new EventTarget(), docEvents=new EventTarget(), local=new Map();
  const ctx=vm.createContext({console, structuredClone, TextEncoder, TextDecoder, URL, crypto:webcrypto,
    btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary'),
    setTimeout,clearTimeout,setInterval:()=>1,clearInterval:()=>{},CustomEvent,
    navigator:{onLine:false},indexedDB:sharedDB||new MemoryIDB(),
    localStorage:{getItem:k=>local.get(k)||null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)},
    addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events),
    document:{hidden:false,addEventListener:docEvents.addEventListener.bind(docEvents)},
    supabase:sdk(backend),READING_WORDS_SUPABASE_CONFIG:{url:'test-only',publishableKey:'test-only'}
  });
  ctx.window=ctx;
  const run=code=>vm.runInContext(code,ctx);
  for(const f of ['sync-model.js','db.js','cloud-sync.js'])run(fs.readFileSync(path.join(__dirname,'../..',f),'utf8'));
  await run('Promise.all([openReadingDB(),rwInitCloud()])');
  const call=async(code,arg)=>{ctx.__args=clone(arg);return clone(await run(code));};
  return {ctx,run,backend,
    add:input=>call('saveReadingWord(__args)',input),
    word:term=>call('findReadingWordByNormalizedTerm(__args)',term),
    words:()=>call('getAllReadingWords()'),
    edit:(term,patch)=>call('(async()=>{const w=await findReadingWordByNormalizedTerm(__args[0]);return updateReadingWord(w.id,__args[1],{base:w});})()',[term,patch]),
    delete:term=>call('(async()=>{const w=await findReadingWordByNormalizedTerm(__args);return deleteReadingWord(w.id);})()',term),
    login:email=>call('ReadingWordsCloud.login(__args)',email||'reader@test.local'),
    sync:()=>call('(async()=>{rwCloudState.online=true;try{return await rwSyncNow();}finally{rwCloudState.online=false;clearTimeout(rwLocalSyncDebounce);}})()'),
    snapshot:()=>call('getReadingSyncSnapshot()')
  };
}
module.exports={Backend,device,clone,delay};
