"""UI-only Chromium checks using about:blank and injected production HTML/CSS/JS.
IndexedDB, localStorage, Supabase, and serviceWorker are explicit test doubles.
NOT a real-browser IndexedDB/PWA or live-Supabase end-to-end test.
Run: python tests/test_browser.py (requires playwright and Chromium).
"""
import json, os, re, shutil
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
report={'environment':'Chromium about:blank; production scripts; mocked IndexedDB/Supabase/network/service worker','checks':[],'errors':[]}
def ok(name,condition=True):
    report['checks'].append({'name':name,'passed':bool(condition)})
    print(('PASS ' if condition else 'FAIL ')+name,flush=True)
    assert condition,name
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':390,'height':920})
    page.on('pageerror',lambda e:report['errors'].append(str(e)))
    page.on('dialog',lambda d:d.accept())
    html=(ROOT/'index.html').read_text()
    html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S)
    html=re.sub(r'<link\b[^>]+>','',html)
    page.set_content(html)
    page.add_style_tag(content=(ROOT/'style.css').read_text())
    page.add_script_tag(content=(ROOT/'tests/support/memory-idb.cjs').read_text())
    page.evaluate('''() => {
      Object.defineProperty(window,'indexedDB',{value:new CET6MemoryIDB(),configurable:true});
      const local=new Map();
      Object.defineProperty(window,'localStorage',{value:{getItem:k=>local.get(k)||null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)},configurable:true});
      Object.defineProperty(window,'BroadcastChannel',{value:undefined,configurable:true});
      if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('')});
      Object.defineProperty(navigator,'serviceWorker',{value:{register:async url=>{window.__registeredSW=url;return {update:async()=>{}};}},configurable:true});
      window.__remoteRows=new Map();
      window.fetch=async(url,init)=>{
        const q=JSON.parse(init.body), rows=window.__remoteRows;
        const matches=row=>row.user_id===q.authUser&&q.filters.every(([op,f,v])=>{
          const a=f==='payload->>syncToken'?row.payload?.syncToken??null:row[f];return op==='gt'?a>v:a===v;
        });
        let result;
        if(q.op==='select'){
          let values=[...rows.values()].filter(matches);
          if(q.order)values.sort((a,b)=>a[q.order]===b[q.order]?0:a[q.order]>b[q.order]?1:-1);
          values=values.slice(0,q.limit);
          result={data:q.single?values[0]||null:values,error:null};
        }else{
          const key=q.row.record_key,old=rows.get(key);
          if(q.op==='insert'&&old)result={error:{code:'23505',message:'duplicate'}};
          else if(q.op==='update'&&(!old||!matches(old)))result={data:[],error:null};
          else{rows.set(key,structuredClone(q.row));result={data:[q.row],error:null};}
        }
        return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}});
      };
    }''')
    page.add_script_tag(content=(ROOT/'tests/mock-supabase.js').read_text())
    for f in ['sync-model.js','db.js','supabase-config.js','cloud-sync.js','app.js']:
        page.add_script_tag(content=(ROOT/f).read_text())
    page.wait_for_function('window.READING_WORDS_DB_READY && ReadingWordsCloud.getStatus().ready')
    ok('首页与登录表单初始化',page.locator('#authForm').count()==1 and page.locator('.app-version').inner_text().endswith('v3.2.0 编辑同步版'))
    page.locator('#term').fill('atribute')
    page.locator('#meaning').fill('归因')
    page.locator('#source').fill('六级阅读')
    page.locator('#sentence').fill('They attribute their success to hard work.')
    page.locator('#note').fill('旧备注')
    page.locator('#saveButton').click()
    page.wait_for_function("document.getElementById('wordCount').textContent==='1'")
    old=page.evaluate("findReadingWordByNormalizedTerm('atribute')")
    ok('保存后词卡同时有编辑和删除按钮',page.locator('[data-edit-id]').count()==1 and page.locator('[data-delete-id]').count()==1)
    page.locator('[data-edit-id]').click()
    page.wait_for_function("document.getElementById('saveTitle').textContent==='编辑生词' && !formBusy")
    ok('编辑自动回填原内容',page.locator('#term').input_value()=='atribute' and page.locator('#source').input_value()=='六级阅读')
    page.locator('#term').fill('attribute')
    page.locator('#meaning').fill('v. 把……归因于；n. 属性')
    page.locator('#note').fill('')
    page.locator('#saveButton').click()
    page.wait_for_function("document.getElementById('saveTitle').textContent==='保存生词'")
    edited=page.evaluate("findReadingWordByNormalizedTerm('attribute')")
    ok('编辑不增加词条或遇见次数且保留ID',edited['id']==old['id'] and edited['occurrenceCount']==old['occurrenceCount'] and page.locator('#wordCount').inner_text()=='1')
    ok('改拼写移除旧词头，清空备注有效',page.evaluate("findReadingWordByNormalizedTerm('atribute')") is None and edited['note']=='')
    page.locator('#term').fill('未提交新增草稿')
    page.locator('[data-edit-id]').click()
    page.wait_for_function("document.getElementById('saveTitle').textContent==='编辑生词' && !formBusy")
    page.locator('#note').fill('不保存')
    page.locator('#cancelEditButton').click()
    ok('取消编辑不修改记录并恢复原新增草稿',page.evaluate("findReadingWordByNormalizedTerm('attribute')")['note']=='' and page.locator('#term').input_value()=='未提交新增草稿')
    page.locator('#term').fill('')
    page.locator('[data-edit-id]').click()
    page.wait_for_function("document.getElementById('saveTitle').textContent==='编辑生词' && !formBusy")
    page.locator('#note').fill('本地编辑草稿')
    page.evaluate("""async()=>{const w=await findReadingWordByNormalizedTerm('attribute');const at=ReadingWordsModel.nextTime(w);await applyReadingStateFromCloud(ReadingWordsModel.wordState(ReadingWordsModel.patchWord(w,{source:'手机新来源'},'phone',at)));window.dispatchEvent(new CustomEvent('reading-words-cloud-data-updated'));}""")
    page.wait_for_function("document.getElementById('formMessage').textContent.includes('草稿已保留')")
    ok('后台同步只刷新列表，不覆盖正在输入的草稿',page.locator('#note').input_value()=='本地编辑草稿')
    page.locator('#saveButton').click()
    page.wait_for_function("document.getElementById('saveTitle').textContent==='保存生词'")
    ok('保存草稿只写触碰字段，保留手机新来源',page.evaluate("findReadingWordByNormalizedTerm('attribute')")['source']=='手机新来源')
    page.locator('[data-edit-id]').click()
    page.wait_for_function("document.getElementById('saveTitle').textContent==='编辑生词' && !formBusy")
    page.locator('#note').fill('冲突草稿')
    page.evaluate("""async()=>{const w=await findReadingWordByNormalizedTerm('attribute');await updateReadingWord(w.id,{note:'另一页面更新'},{base:w});}""")
    page.locator('#saveButton').click()
    page.wait_for_function("!document.getElementById('saveButton').disabled")
    ok('发现同字段冲突时保留草稿并提示',page.locator('#note').input_value()=='冲突草稿' and '其他设备更新' in page.locator('#formMessage').inner_text())
    page.locator('#cancelEditButton').click()
    page.evaluate("saveReadingWord({term:'mirror',meaning:'镜子'})")
    page.evaluate('refreshList()')
    page.locator(f'[data-edit-id="{old["id"]}"]').click()
    page.wait_for_function("document.getElementById('saveTitle').textContent==='编辑生词' && !formBusy")
    page.locator('#term').fill('mirror')
    page.locator('#saveButton').click()
    page.wait_for_function("!document.getElementById('saveButton').disabled")
    ok('改名撞词会提示，不覆盖另一词条','已有相同单词' in page.locator('#formMessage').inner_text() and page.locator('#wordCount').inner_text()=='2')
    page.locator('#cancelEditButton').click()
    page.evaluate("saveReadingWord({term:'<img src=x onerror=alert(1)>',note:'<script>alert(1)</script>'})")
    page.evaluate('refreshList()')
    ok('编辑和显示入口转义词条HTML',page.locator('#wordList img').count()==0 and page.locator('#wordList script').count()==0)
    # 实际登录入口与同步事件，云端为本地内存替身。
    page.locator('#cloudEmail').fill('reader@example.test')
    page.locator('#cloudPassword').fill('test-password')
    page.locator('#authForm button[type=submit]').click()
    page.wait_for_function('ReadingWordsCloud.getStatus().signedIn && ReadingWordsCloud.getStatus().lastSyncAt')
    page.wait_for_function('!ReadingWordsCloud.getStatus().syncing')
    ok('登录后保留列表并上传至模拟云端',page.locator('#wordCount').inner_text()=='3' and page.evaluate('__remoteRows.size')>=3)
    page.locator(f'[data-edit-id="{old["id"]}"]').click()
    page.wait_for_function("document.getElementById('saveTitle').textContent==='编辑生词' && !formBusy")
    page.locator('#note').fill('attribute A to B：把 A 归因于 B')
    page.locator('#saveButton').click()
    page.wait_for_function("document.getElementById('saveTitle').textContent==='保存生词'")
    page.wait_for_function("[...__remoteRows.values()].some(r=>r.payload.note==='attribute A to B：把 A 归因于 B')")
    ok('保存修改后自动同步（模拟云端）')
    page.locator(f'[data-edit-id="{old["id"]}"]').click()
    page.wait_for_function("document.getElementById('saveTitle').textContent==='编辑生词' && !formBusy")
    page.locator('#note').fill('不要意外删除')
    page.evaluate("""async()=>{const w=await findReadingWordByNormalizedTerm('attribute');await deleteReadingWord(w.id);window.dispatchEvent(new CustomEvent('reading-words-cloud-data-updated'));}""")
    page.locator('#saveButton').click()
    page.wait_for_function("!document.getElementById('saveButton').disabled")
    ok('编辑中被删除不会被保存按钮复活','已被其他设备删除或改名' in page.locator('#formMessage').inner_text() and page.locator('#note').input_value()=='不要意外删除')
    page.locator('#cancelEditButton').click()
    page.evaluate("""async()=>{const x=(await getAllReadingWords()).find(w=>w.term.startsWith('<'));await deleteReadingWord(x.id);await saveReadingWord({term:'attribute',meaning:'v. 把……归因于；n. 属性',source:'六级阅读',sentence:'They attribute their success to hard work.',note:'attribute A to B：把 A 归因于 B'});await refreshList();}""")
    attr=page.evaluate("findReadingWordByNormalizedTerm('attribute')")
    page.locator(f'[data-edit-id="{attr["id"]}"]').click()
    page.wait_for_function("document.getElementById('saveTitle').textContent==='编辑生词' && !formBusy")
    for width in [360,390,560,1100]:
        page.set_viewport_size({'width':width,'height':920})
        ok(f'{width}px 页面无横向溢出',page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
    page.evaluate('scrollTo(0,0)')
    page.screenshot(path=str(ROOT/'tests/UI-v3.2.0-desktop.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':920})
    page.screenshot(path=str(ROOT/'tests/UI-v3.2.0-mobile.png'),full_page=True)
    ok('App 调用了新版 SW 注册（注册接口为替身）',page.evaluate('__registeredSW')=='./service-worker.js?v=3.2.0')
    ok('没有未捕获页面脚本异常',not report['errors'])
    browser.close()
report['passed']=sum(c['passed'] for c in report['checks'])
report['total']=len(report['checks'])
(ROOT/'tests/browser-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
