const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const base='https://test.example/CET6-Review/';
class CacheStorageDouble {
 constructor(){this.buckets=new Map();this.fetcher=null;this.failPut=false;}
 key(request){return new URL(typeof request==='string'?request:request.url,base).href;}
 async open(name){
  if(!this.buckets.has(name))this.buckets.set(name,new Map());const bucket=this.buckets.get(name),owner=this;
  return {async match(req){return bucket.get(owner.key(req))?.clone();},
   async put(req,res){if(owner.failPut)throw new Error('quota');bucket.set(owner.key(req),res.clone());},
   async addAll(reqs){const pairs=[];for(const r of reqs){const res=await owner.fetcher(r);if(!res.ok)throw new Error('precache failed');pairs.push([owner.key(r),res]);}for(const [k,v]of pairs)bucket.set(k,v.clone());}};
 }
 async keys(){return [...this.buckets.keys()];}
 async delete(name){return this.buckets.delete(name);}
}
function createSW(){
 const caches=new CacheStorageDouble(),listeners=new Map(),calls=[],messages=[];
 let impl=async request=>new Response('NETWORK '+(request.url||request));let claimed=0,skipped=0;
 const fetcher=(request,options)=>{calls.push({url:request.url||request,request,options});return impl(request,options);};caches.fetcher=fetcher;
 const self={location:new URL(base+'service-worker.js'),addEventListener:(t,f)=>listeners.set(t,f),
  skipWaiting:async()=>{skipped++;},clients:{claim:async()=>{claimed++;},matchAll:async()=>[{postMessage:m=>messages.push(m)}]}};
 const context={self,caches,URL,Request,Response,AbortController,Promise,console:{warn(){}},
  setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,25)),clearTimeout,fetch:fetcher};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../../service-worker.js'),'utf8'),context);
 const run=code=>vm.runInContext(code,context);
 async function dispatch(type,attrs={}){let response,work=[];const event={...attrs,waitUntil:p=>work.push(p),respondWith:p=>{response=p;}};listeners.get(type)?.(event);const res=response?await response:undefined;await Promise.all(work);return res;}
 return {context,run,caches,calls,messages,setFetch:f=>{impl=f;},dispatch,base,
  request:(path,mode='cors')=>({url:new URL(path,base).href,mode,method:'GET'}),
  counts:()=>({claimed,skipped})};
}
module.exports={createSW};
