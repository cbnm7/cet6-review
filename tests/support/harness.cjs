const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {MemoryIDB}=require('./memory-idb.cjs');
const root=path.resolve(__dirname,'../..');
function createContext(files=['scheduler.js','db.js','backup.js','cloud-sync.js']) {
  const listeners=new Map(), storage=new Map();
  const idb=new MemoryIDB();
  const context={
    console: { log(){},warn(){},error(){} }, indexedDB:idb,
    Date, Map, Set, Promise, structuredClone, TextEncoder,TextDecoder, URL, Blob,
    setTimeout,clearTimeout, setImmediate,
    setInterval(){return 1;},clearInterval(){},
    btoa:s=>Buffer.from(s,'binary').toString('base64'),
    atob:s=>Buffer.from(s,'base64').toString('binary'),
    navigator:{onLine:false}, location:{reload(){}},
    localStorage:{getItem:k=>storage.get(k)??null, setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},
    document:{querySelector(){return null;},addEventListener(){},hidden:false},
    CustomEvent:class {constructor(type,options={}){this.type=type;this.detail=options.detail;}},
    addEventListener(type,listener){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(listener);},
    removeEventListener(type,listener){listeners.set(type,(listeners.get(type)||[]).filter(x=>x!==listener));},
    dispatchEvent(event){for(const l of listeners.get(event.type)||[])l(event);return true;},
    fetch:()=>Promise.reject(new Error('test network disabled')),
  };
  context.window=context;
  vm.createContext(context);
  for(const file of files) vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
  return {context,idb,storage,run:code=>vm.runInContext(code,context)};
}
const clean=x=>JSON.parse(JSON.stringify(x));
const word=(i)=>({id:`w${String(i).padStart(4,'0')}`,term:`word${i}`,source_order:i});
function modernWord(i,overrides={}) {
  return {id:word(i).id,term:word(i).term,schedulerVersion:2,stateRevision:8,
    roundCount:1,reviewCount:1,knowCount:1,forgotCount:0,lastRating:'know',
    remediationActive:false,reviewStage:null,nextReviewDate:null,
    lastReviewedDate:'2026-10-15',lastReviewedAt:'2026-10-15T04:00:00Z',updatedAt:'2026-10-15T04:00:00Z',...overrides};
}
const session=(date,overrides={})=>({date,schedulerVersion:2,stateRevision:7,queue:[{id:'w0001',type:'primary'}],cursor:1,
 initialPrimaryCount:1,primaryCompleted:1,know:1,forgot:0,reinforcementAttempts:0,
 primaryRatings:{w0001:'know'},completedAt:`${date}T04:00:00Z`,updatedAt:`${date}T04:00:00Z`,...overrides});
function backup(stores,overrides={}){
 return {format:'cet6-review-backup',schemaVersion:1,appVersion:'2.2.0',
  stores:{wordProgress:[],dailySessions:[],dailyStats:[],readingWords:[],...stores},...overrides};
}
const file=data=>({text:async()=>JSON.stringify(data)});
module.exports={createContext,root,clean,word,modernWord,session,backup,file};
