"""UI-only Chromium check. about:blank + injected production scripts.
Storage/network use explicit test doubles; NOT real PWA/IndexedDB e2e.
Requires Python playwright and a Chromium binary; runtime app needs neither.
"""
from pathlib import Path
import json,re,os
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
report={'environment':'Chromium about:blank, injected actual app/CSS; in-memory IndexedDB + fetch/localStorage doubles; no live Supabase or Service Worker', 'checks':[],'errors':[]}
def ok(name, detail=True): report['checks'].append({'name':name,'passed':True,'detail':detail})
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':390,'height':844})
    page.on('pageerror',lambda error:report['errors'].append(str(error)))
    html=(ROOT/'index.html').read_text()
    html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S)
    html=re.sub(r'<link[^>]+>','',html)
    page.set_content(html)
    page.add_style_tag(content=(ROOT/'style.css').read_text())
    page.add_script_tag(content=(ROOT/'tests/support/memory-idb.cjs').read_text())
    page.evaluate('''() => {
      Object.defineProperty(window,'indexedDB',{value:new CET6MemoryIDB(), configurable:true});
      const values=new Map();
      Object.defineProperty(window,'localStorage',{value:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)},configurable:true});
      window.CET6_SUPABASE_CONFIG={};window.__alerts=[];window.alert=message=>window.__alerts.push(message);
    }''')
    data=(ROOT/'data/cet6_2003.json').read_text()
    page.evaluate('''data=>{window.fetch=async url=>{if(String(url).includes('cet6_2003.json'))return new Response(data,{status:200,headers:{'Content-Type':'application/json'}});throw new Error('test network unavailable');};}''',data)
    for file in ['scheduler.js','db.js','data/concise-dictionary.js','dictionary.js','backup.js','pwa.js','cloud-sync.js','app.js']:
        page.add_script_tag(content=(ROOT/file).read_text())
    page.wait_for_function('vocabulary.length===2003 && lastDictionaryCoverage?.reviewed===1992',timeout=25000)
    assert not page.evaluate('window.__alerts'),page.evaluate('window.__alerts')
    ok('首页初始化2003词，原词典1992词头就绪')
    page.locator('#settingsBtn').click()
    page.wait_for_selector('#exportPreImportBackupBtn')
    assert '2.2.1 数据保护与渐进加练版' in page.locator('.dictionary-source-card').inner_text()
    assert page.locator('#checkAppUpdateBtn').count()==1
    ok('设置页新版号、检查更新、导入前快照按钮')
    page.locator('#exportPreImportBackupBtn').click()
    page.wait_for_function("document.querySelector('#backupMessage').textContent.includes('还没有导入前快照')")
    ok('尚无快照时给出明确提示，不改变数据')
    page.locator('#settingsBackBtn').click();page.wait_for_selector('#startReviewBtn');page.locator('#startReviewBtn').click()
    page.wait_for_selector('.rating-btn')
    first_id=page.evaluate('currentSession.queue[0].id')
    page.locator('[data-rating="forgot"]').click();page.wait_for_selector('#nextAfterAnswerBtn')
    q=page.evaluate('currentSession.queue');assert q[11]['id']==first_id and q[11]['scheduledGap']==10
    ok('今日任务忘记后隔10项加练，正式任务仍200')
    page.locator('#nextAfterAnswerBtn').click();page.wait_for_selector('.rating-btn');page.locator('[data-rating="know"]').click();page.wait_for_selector('#markMistakeBtn')
    page.locator('#markMistakeBtn').click();page.wait_for_function("currentSession.forgot===2 && !isSaving")
    assert page.evaluate('currentSession.primaryCompleted')==2 and page.evaluate('currentSession.know')==0
    ok('正式任务认识→记错了，不重复计数，追加加练')
    # Answer all intervening cards via visible buttons until first reinforcement.
    page.locator('#nextAfterAnswerBtn').click();page.wait_for_selector('.rating-btn')
    for _ in range(20):
        if page.evaluate("currentSession.queue[currentSession.cursor].type==='reinforcement'"): break
        page.locator('[data-rating="know"]').click();page.wait_for_selector('#nextAfterAnswerBtn')
        page.locator('#nextAfterAnswerBtn').click();page.wait_for_selector('.rating-btn')
    else: raise AssertionError('first reinforcement not reached')
    assert page.evaluate('currentSession.queue[currentSession.cursor].id')==first_id
    primary_before=page.evaluate('currentSession.primaryCompleted')
    page.locator('[data-rating="know"]').click();page.wait_for_selector('#markMistakeBtn');page.locator('#markMistakeBtn').click()
    page.wait_for_function('!isSaving && currentSession.reinforcementAttempts===1')
    pending=page.evaluate('(id)=>currentSession.queue.slice(currentSession.cursor).find(i=>i.id===id)',first_id)
    assert pending['reinforcementLevel']==2 and pending['scheduledGap']==25
    assert page.evaluate('currentSession.primaryCompleted')==primary_before
    ok('加练认识→记错了按25项再插入，不增加正式配额')
    # Re-read persisted session rather than relying on currentSession memory.
    page.evaluate('async()=>{currentSession=null;await showHomePage();await startReview();}')
    pending=page.evaluate('(id)=>currentSession.queue.slice(currentSession.cursor).find(i=>i.id===id)',first_id)
    assert pending['reinforcementLevel']==2 and pending['scheduledGap']==25
    ok('重新读取会话后保留加练层级和断点（模拟数据库）')
    backup=page.evaluate('async()=>await buildStudyBackup()')
    assert backup['schemaVersion']==2 and backup['scheduler']['migration']['version']==2
    ok('页面导出备份包含调度与迁移版本')
    page.evaluate('showAppUpdateNotice("2.2.2")')
    page.wait_for_selector('#appUpdateNotice')
    page.evaluate('isSaving=true');page.locator('#appUpdateNotice button').click()
    assert '正在保存' in page.locator('#appUpdateNotice').inner_text()
    page.evaluate('isSaving=false;document.querySelector("#appUpdateNotice").remove()')
    ok('新版本提示不会在保存中强制刷新')
    page.evaluate('async()=>await showSettingsPage()')
    for width in [360,390,480]:
        page.set_viewport_size({'width':width,'height':844})
        dims=page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
        assert dims['scroll']<=dims['width'],dims
        ok(f'{width}px设置页无横向溢出',dims)
    page.screenshot(path=str(ROOT/'tests/UI_v2.2.1_settings.png'),full_page=True)
    assert not report['errors'],report['errors']
    assert not page.evaluate('window.__alerts'),page.evaluate('window.__alerts')
    ok('UI过程中无未处理脚本异常或保存失败提示')
    browser.close()
report['passed']=len(report['checks'])
(ROOT/'tests/UI_v2.2.1_RESULTS.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
