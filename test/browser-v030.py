"""Browser fixtures for v0.3.0. No logged-in ChatGPT or desktop-app E2E claims.
Run with Playwright installed: CHROMIUM_PATH=/usr/bin/chromium python test/browser-v030.py
"""
import os
import json
from pathlib import Path
import unittest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'http://localhost:18761'
TEX = r'G_k = \text{当前 occlusion frontier}'
def katex(tex=TEX, display=True):
    value = ('<span class="katex"><span class="katex-mathml"><math><semantics><mi>rendered</mi>'
             f'<annotation encoding="application/x-tex">{tex}</annotation></semantics></math></span>'
             '<span class="katex-html" aria-hidden="true"><span class="glyph">rendered</span></span></span>')
    return f'<span class="katex-display">{value}</span>' if display else value
BOOT = '''
window.metrics={fetches:0,observers:0,queries:0};
window.originals={range:Range.prototype.toString,selection:Selection.prototype.toString,clone:Range.prototype.cloneContents};
const MO=MutationObserver;window.MutationObserver=class extends MO{constructor(...args){super(...args);metrics.observers++;}};
for(const p of [Document.prototype,Element.prototype]){const q=p.querySelectorAll;p.querySelectorAll=function(s){if(/katex|math|latex/.test(s))metrics.queries++;return q.call(this,s);};}
window.fetch=async()=>{metrics.fetches++;throw new Error('not mocked');};
'''
class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw=sync_playwright().start()
        cls.browser=cls.pw.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'), args=['--no-sandbox'])
        print('Chromium',cls.browser.version)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()
    def setUp(self):
        self.context=self.browser.new_context(permissions=['clipboard-read','clipboard-write'])
        self.context.add_init_script(BOOT)
        self.page=self.context.new_page();self.errors=[]
        self.page.on('pageerror',lambda e:self.errors.append(str(e)))
        self.body=''
        self.context.route(ORIGIN+'/**',self.serve)
        self.fixture('<p>test</p>')
    def serve(self,route):
        if route.request.url.endswith('/script.js'):
            route.fulfill(content_type='text/javascript',body=(ROOT/'OmniGPT.user.js').read_text())
        else:
            route.fulfill(content_type='text/html',headers={'Content-Security-Policy':"script-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'"},body='<!doctype html><html><head><meta charset="utf-8"><script src="/script.js"></script></head><body><main>'+self.body+'</main><textarea id="paste"></textarea><div id="rich" contenteditable="true"></div></body></html>')
    def fixture(self,content,full=False):
        self.body=content if full else '<section data-turn="assistant"><div id="case" class="markdown">'+content+'</div></section>'
        self.page.goto(ORIGIN+'/c/test-id')
        self.assertEqual(self.errors,[])
    def tearDown(self):self.context.close()
    def select(self,css='#case'):
        self.page.evaluate('css=>{const r=document.createRange();r.selectNodeContents(document.querySelector(css));const s=getSelection();s.removeAllRanges();s.addRange(r);}',css)
    def payload(self):return self.page.evaluate('OmniGPTClipboard.selectionPayload(getSelection())')
    def open(self):self.page.locator('.omnigpt-launcher').click()
    def more(self):self.page.locator('#omnigpt-root summary').click()
    def test_01_inline_and_display_not_all_dollars(self):
        self.fixture('<p>Inline '+katex('x_i',False)+'</p>'+katex('y_i'));self.select()
        self.assertEqual(self.payload()['text'],'Inline $x_i$\n\n$$\ny_i\n$$')
    def test_02_latex_copy_style(self):
        self.fixture('<p>'+katex('x_i',False)+'</p>'+katex('y_i'));self.select()
        self.page.evaluate('OmniGPTClipboard.setMathStyle("latex")')
        self.assertEqual(self.payload()['text'],'\\(x_i\\)\n\n\\[\ny_i\n\\]')
    def test_03_explicit_inline_source_beats_misleading_display_wrapper(self):
        self.fixture(r'<div class="math-display"><span data-latex="\(x_i\)">x</span></div>');self.select()
        self.assertEqual(self.payload()['text'],'$x_i$')
    def test_04_partial_selection_stays_inline(self):
        self.fixture('<p>before '+katex('x_i',False)+' after</p>')
        self.page.evaluate('''()=>{const n=document.querySelector('.glyph').firstChild;const r=document.createRange();r.setStart(n,1);r.setEnd(n,3);getSelection().removeAllRanges();getSelection().addRange(r);}''')
        self.assertEqual(self.payload()['text'],'$x_i$')
    def test_05_plain_only_copy_event(self):
        self.fixture(katex());self.select()
        data=self.page.evaluate('''()=>{const dt=new DataTransfer();dt.setData('text/html','bad');const e=new ClipboardEvent('copy',{clipboardData:dt,cancelable:true,bubbles:true});document.querySelector('#case').dispatchEvent(e);return {types:[...dt.types],text:dt.getData('text/plain')};}''')
        self.assertEqual(data,{'types':['text/plain'],'text':'$$\n'+TEX+'\n$$'})
    def test_06_real_keyboard_clipboard_and_paste(self):
        self.fixture('<p>其中：</p>'+katex()+'<p>结束。</p>');self.select();self.page.keyboard.press('Control+c')
        self.assertEqual(self.page.evaluate('navigator.clipboard.readText()'),'其中：\n\n$$\n'+TEX+'\n$$\n\n结束。')
        self.assertEqual(self.page.evaluate('navigator.clipboard.read().then(x=>x.flatMap(y=>y.types))'),['text/plain'])
        self.page.locator('#paste').focus();self.page.keyboard.press('Control+v')
        self.assertEqual(self.page.locator('#paste').input_value(),'其中：\n\n$$\n'+TEX+'\n$$\n\n结束。')
    def test_07_alt_double_click_raw_tex(self):
        self.fixture(katex());self.page.locator('.glyph').dblclick(modifiers=['Alt'])
        self.assertEqual(self.page.evaluate('navigator.clipboard.readText()'),TEX)
    def test_08_lazy_panel_and_idle_no_work(self):
        self.assertEqual(self.page.locator('.omnigpt-panel').count(),0)
        before=self.page.evaluate('({...metrics})')
        self.page.evaluate('''()=>{for(let i=0;i<500;i++){const p=document.createElement('p');p.textContent='stream';document.querySelector('main').append(p);}}''')
        self.page.wait_for_timeout(30)
        self.assertEqual(self.page.evaluate('({...metrics})'),before)
        self.assertEqual(before,{'fetches':0,'observers':0,'queries':0})
        self.assertTrue(self.page.evaluate('Range.prototype.toString===originals.range&&Range.prototype.cloneContents===originals.clone&&Selection.prototype.toString===originals.selection'))
        self.open();self.assertEqual(self.page.locator('.omnigpt-panel').count(),1)
    def test_09_trusted_types_and_close_focus(self):
        self.assertTrue(self.page.evaluate('''()=>{try{document.createElement('div').innerHTML='x';return false;}catch(e){return true;}}'''))
        self.open();self.assertTrue(self.page.locator('.omnigpt-panel').is_visible())
        self.page.keyboard.press('Escape');self.assertFalse(self.page.locator('.omnigpt-panel').is_visible())
        self.assertEqual(self.page.evaluate('document.activeElement.className'),'omnigpt-launcher')
        self.assertEqual(self.errors,[])
    def test_10_dom_alternates_roles_no_duplicates(self):
        self.fixture('<section data-turn="user"><div data-message-author-role="user">Q1</div></section><section data-turn="assistant"><div data-message-author-role="assistant">A1</div></section><section data-turn="user">Q2</section><section data-turn="assistant">A2</section>',True)
        c=self.page.evaluate('ChatGPTExporter.collectConversation(document)')
        self.assertEqual([m['role'] for m in c['messages']],['user','assistant','user','assistant'])
        self.assertEqual([m['text'] for m in c['messages']],['Q1','A1','Q2','A2'])
        self.assertTrue(c['partial']);self.assertEqual(c['acquisition'],'dom')
    def test_11_dom_export_shares_math_and_code_renderer(self):
        code='if x:\n    print(x)\n\n\n    return x\n'
        self.fixture('<p>'+katex('x_i',False)+'</p><pre><code class="language-python">'+code+'</code></pre><p>tail</p>')
        c=self.page.evaluate('ChatGPTExporter.collectConversation(document)')
        self.assertIn('$x_i$',c['messages'][0]['markdown']);self.assertIn(code.rstrip('\n'),c['messages'][0]['markdown'])
        self.assertIn('tail',c['messages'][0]['markdown'])
    def test_12_dom_export_does_not_change_selection(self):
        self.fixture('<p id="small">hello '+katex('x_i',False)+'</p><p>other</p>');self.select('#small')
        before=self.page.evaluate('getSelection().toString()');self.page.evaluate('ChatGPTExporter.collectConversation(document)')
        self.assertEqual(before,self.page.evaluate('getSelection().toString()'))
    def test_13_quote_setting_optional_reversible(self):
        self.open();self.more();box=self.page.locator('[data-field=quote]')
        self.assertFalse(box.is_checked());box.check();self.assertTrue(self.page.evaluate('OmniGPTClipboard.quoteCompatibility'))
        box.uncheck();self.assertTrue(self.page.evaluate('Range.prototype.toString===originals.range'))
    def test_14_format_style_setting_persists(self):
        self.open();self.more();self.page.locator('[data-field=mathStyle]').select_option('latex')
        self.page.reload();self.assertEqual(self.page.evaluate('OmniGPTClipboard.mathStyle'),'latex')
        self.open();self.page.locator('[data-field=format]').select_option('json');self.page.reload();self.open()
        self.assertEqual(self.page.locator('[data-field=format]').input_value(),'json')
        self.assertEqual(self.page.locator('[data-field=scope]').input_value(),'current')
    def test_15_history_copy_disabled_and_scope_fields(self):
        self.open();self.page.locator('[data-field=scope]').select_option('all');self.more()
        self.assertTrue(self.page.locator('[data-action=copy]').is_disabled())
        self.assertTrue(self.page.locator('[data-field=limit]').is_visible());self.assertFalse(self.page.locator('[data-field=source]').is_visible())
    def test_16_offline_page_export_and_warning(self):
        self.fixture('<p>Offline '+katex('x_i',False)+'</p>');self.open();self.more();self.page.locator('[data-field=source]').select_option('dom')
        with self.page.expect_download() as d:self.page.locator('[data-action=export]').click()
        content=Path(d.value.path()).read_text();self.assertIn('Offline $x_i$',content);self.assertIn('可能缺失',content)
        self.assertEqual(self.page.evaluate('metrics.fetches'),0)
        self.assertIn('已请求下载',self.page.locator('.omnigpt-status').inner_text())
    def test_17_cancel_inflight_ui(self):
        self.page.evaluate('''()=>{window.wasAborted=false;window.fetch=(u,o)=>u.endsWith('/api/auth/session')?Promise.resolve({ok:true,json:async()=>({accessToken:'x'})}):new Promise((_,reject)=>o.signal.addEventListener('abort',()=>{wasAborted=true;reject(new Error('abort'));}));}''')
        self.open();self.page.locator('[data-action=export]').click();self.page.wait_for_timeout(10)
        self.assertTrue(self.page.locator('[data-action=cancel]').is_visible());self.page.locator('[data-action=cancel]').click()
        self.page.wait_for_function('window.wasAborted');self.assertIn('已取消',self.page.locator('.omnigpt-status').inner_text())
    def test_18_narrow_light_dark_bounds(self):
        for width,scheme in [(1280,'light'),(600,'dark'),(390,'light')]:
            self.page.set_viewport_size({'width':width,'height':720});self.page.emulate_media(color_scheme=scheme)
            if self.page.locator('.omnigpt-panel').count() and self.page.locator('.omnigpt-panel').is_visible():self.page.keyboard.press('Escape')
            self.open();self.more()
            box=self.page.locator('.omnigpt-panel').bounding_box()
            self.assertGreaterEqual(box['x'],0);self.assertLessEqual(box['x']+box['width'],width)
            self.assertGreaterEqual(box['y'],0);self.assertLessEqual(box['y']+box['height'],720)
            self.page.screenshot(path=str(ROOT/f'ui-{width}-{scheme}.png'))
    def test_19_long_page_selection_locality(self):
        extra=''.join('<section data-turn="assistant">'+katex('outside',False)+'</section>' for _ in range(3000))
        self.fixture(extra+'<section data-turn="assistant"><p id="case">only '+katex('x_i',False)+'</p></section>',True);self.select()
        data=self.payload();self.assertLess(data['visitedNodes'],10);self.assertEqual(data['text'],'only $x_i$')
        print('Locality:',json.dumps({'surrounding':3000,'visited':data['visitedNodes']}))
    def test_20_images_only_turns_not_silently_dropped(self):
        self.fixture('<img src="https://example.org/img.png" alt="diagram">')
        c=self.page.evaluate('ChatGPTExporter.collectConversation(document)')
        self.assertEqual(c['messageCount'],1);self.assertIn('diagram',c['messages'][0]['markdown'])

if __name__=='__main__':unittest.main(verbosity=2)
