// 测试专用 SDK 替身。页面通过 add_init_script 注入；index.html 不会加载本文件。
// 所有请求仅发送到本机测试 HTTP 服务，绝不访问真实 Supabase 账号。
(() => {
  let session = JSON.parse(localStorage.getItem('__test_session') || 'null');
  let authCallback = () => {};
  class Query {
    constructor() { this.query = { op:'select', filters:[], limit:1000 }; }
    select(columns) { this.query.columns=columns; return this; }
    eq(field,value) { this.query.filters.push(['eq',field,value]); return this; }
    is(field,value) { this.query.filters.push(['is',field,value]); return this; }
    gt(field,value) { this.query.filters.push(['gt',field,value]); return this; }
    order(field,options) { this.query.order=field; this.query.ascending=options?.ascending !== false; return this; }
    limit(n) { this.query.limit=n; return this; }
    maybeSingle() { this.query.single=true; return this; }
    insert(row) { this.query.op='insert'; this.query.row=row; return this; }
    update(row) { this.query.op='update'; this.query.row=row; return this; }
    then(resolve,reject) {
      return fetch('/__mock_sync__',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({...this.query,authUser:session?.user?.id || null})})
        .then(r=>r.json()).then(resolve,reject);
    }
  }
  function signedIn(email) {
    session={user:{id:'test-'+email,email}};
    localStorage.setItem('__test_session',JSON.stringify(session));
    authCallback('SIGNED_IN',session);
    return {data:{user:session.user,session},error:null};
  }
  window.supabase={createClient:()=>({
    from:table=>{ if(table!=='cet6_sync_records') throw new Error('unexpected table'); return new Query(); },
    auth:{
      getSession:async()=>({data:{session},error:null}),
      onAuthStateChange:cb=>{authCallback=cb;return {data:{subscription:{unsubscribe(){}}}};},
      signInWithPassword:async({email})=>signedIn(email),
      signUp:async({email})=>signedIn(email),
      signOut:async()=>{session=null;localStorage.removeItem('__test_session');authCallback('SIGNED_OUT',null);return {error:null};}
    }
  })};
})();
