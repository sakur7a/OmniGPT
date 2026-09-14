"""Real Chromium clipboard and DOM regressions. Dev-only: pip install playwright==1.57.0.
Run: python test/browser-regression.py. Set CHROMIUM_PATH to use a system Chromium.
Fixtures emulate renderer DOM; this does not automate WeChat, Obsidian, or logged-in ChatGPT.
"""
import json
import os
from pathlib import Path
import statistics
import unittest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'http://localhost:18761'
TEX = r'G_k = \text{当前 occlusion frontier}'

def katex(tex=TEX, display=True):
    # Deliberately contains visible glyphs, MathML and a TeX annotation.
    inner = ('<span class="katex"><span class="katex-mathml"><math><semantics>'
             '<mrow><mi>Gk=当前 occlusion frontier</mi></mrow>'
             f'<annotation encoding="application/x-tex">{tex}</annotation>'
             '</semantics></math></span><span class="katex-html" aria-hidden="true">'
             '<span class="glyph">Gk=当前 occlusion frontier</span></span></span>')
    return f'<span class="katex-display">{inner}</span>' if display else inner

BOOT = '''
window.__originals = {range: Range.prototype.toString, selection: Selection.prototype.toString, clone: Range.prototype.cloneContents};
window.__metrics = {observers: 0, mathQueries: 0, fetches: 0, formulaWrites: 0};
const Observer = window.MutationObserver;
window.MutationObserver = class extends Observer { constructor(...args) { super(...args); __metrics.observers++; } };
for (const proto of [Document.prototype, Element.prototype, DocumentFragment.prototype]) {
  const native = proto.querySelectorAll;
  proto.querySelectorAll = function(selector) { if (/katex|math|mjx|latex/.test(selector)) __metrics.mathQueries++; return native.call(this, selector); };
}
const originalSetAttribute = Element.prototype.setAttribute;
Element.prototype.setAttribute = function(name, value) { if (/^data-omnigpt/.test(name)) __metrics.formulaWrites++; return originalSetAttribute.call(this, name, value); };
window.fetch = async () => { __metrics.fetches++; throw new Error('Unexpected network request during clipboard operation'); };
'''

class ClipboardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        opts = {'headless': True, 'args': ['--no-sandbox']}
        if os.environ.get('CHROMIUM_PATH'):
            opts['executable_path'] = os.environ['CHROMIUM_PATH']
        cls.browser = cls.pw.chromium.launch(**opts)
        print('Chromium', cls.browser.version)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.context = self.browser.new_context(permissions=['clipboard-read', 'clipboard-write'])
        self.context.add_init_script(BOOT)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        def serve(route):
            name = route.request.url.split('/')[-1]
            if name in ('clipboard.js', 'omnigpt.js'):
                route.fulfill(content_type='text/javascript', body=(ROOT/'src'/name).read_text())
            elif name == 'stub.js':
                route.fulfill(content_type='text/javascript', body='window.ChatGPTExporter = {};')
            else:
                route.fulfill(content_type='text/html', headers={'Content-Security-Policy': "script-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'"}, body='''<!doctype html><html><head><meta charset="utf-8"><script src="/clipboard.js"></script><script src="/stub.js"></script><script src="/omnigpt.js"></script></head><body><main></main><textarea id="paste"></textarea><div id="rich" contenteditable="true"></div></body></html>''')
        self.context.route(ORIGIN+'/**', serve)
        self.page.goto(ORIGIN+'/')
        self.assertEqual(self.errors, [])

    def tearDown(self):
        self.context.close()

    def fixture(self, contents, extra=''):
        html = f'''<!doctype html><html><head><meta charset="utf-8"><script src="/clipboard.js"></script><script src="/stub.js"></script><script src="/omnigpt.js"></script></head><body><main>{extra}<section data-turn="assistant"><div class="markdown" id="case">{contents}</div></section></main><textarea id="paste"></textarea><div id="rich" contenteditable="true"></div></body></html>'''
        self.page.route(ORIGIN+'/fixture', lambda route: route.fulfill(content_type='text/html', headers={'Content-Security-Policy': "script-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'"}, body=html))
        self.page.goto(ORIGIN+'/fixture')
        self.assertEqual(self.errors, [])

    def select(self, selector='#case'):
        self.page.evaluate('''selector => { const s = getSelection(); s.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(document.querySelector(selector)); s.addRange(r); }''', selector)

    def payload(self):
        return self.page.evaluate('OmniGPTClipboard.selectionPayload(getSelection())')

    def test_01_actual_system_clipboard_plain_only_and_paste(self):
        self.fixture('<p>其中：</p>'+katex()+'<p>即“当前所有没有被剩余 layer 遮挡的层”。</p>')
        self.select()
        self.page.evaluate('''window.lateWrites = 0; window.addEventListener('copy', e => { window.lateWrites++; e.clipboardData.setData('text/html', '<pre><code class="language-math">bad</code></pre>'); });''')
        self.page.keyboard.press('Control+c')
        data = self.page.evaluate('''async () => { const items = await navigator.clipboard.read(); return {types: items.flatMap(i => i.types), text: await navigator.clipboard.readText()}; }''')
        expected = '其中：\n\n$$\n'+TEX+'\n$$\n\n即“当前所有没有被剩余 layer 遮挡的层”。'
        self.assertEqual(data['types'], ['text/plain'])
        self.assertEqual(data['text'], expected)
        self.assertEqual(self.page.evaluate('lateWrites'), 0)
        self.page.locator('#paste').focus()
        self.page.keyboard.press('Control+v')
        self.assertEqual(self.page.locator('#paste').input_value(), expected)
        self.page.locator('#rich').focus()
        self.page.keyboard.press('Control+v')
        self.assertEqual(self.page.locator('#rich').inner_text(), expected)
        self.assertEqual(self.page.locator('#rich pre, #rich math, #rich .katex').count(), 0)

    def test_02_default_prototypes_unchanged_no_observers_or_network(self):
        self.fixture('<p>hello</p>'+katex())
        self.assertTrue(self.page.evaluate('Range.prototype.toString === __originals.range && Selection.prototype.toString === __originals.selection && Range.prototype.cloneContents === __originals.clone'))
        before = self.page.evaluate('({...__metrics})')
        self.page.evaluate('''() => { for (let i=0;i<1000;i++) { const n=document.createElement('span'); n.textContent='stream'; document.querySelector('#case').append(n); } }''')
        self.page.wait_for_timeout(50)
        after = self.page.evaluate('({...__metrics})')
        self.assertEqual(before, after)
        self.assertEqual(after, {'observers': 0, 'mathQueries': 0, 'fetches': 0, 'formulaWrites': 0})

    def test_03_ordinary_copy_and_editors_remain_native(self):
        self.fixture('<p><strong>ordinary text</strong></p>')
        self.select()
        self.page.evaluate('window.late=0; document.addEventListener("copy", () => window.late++)')
        self.page.keyboard.press('Control+c')
        self.assertEqual(self.page.evaluate('late'), 1)
        self.assertEqual(self.page.evaluate('navigator.clipboard.readText()'), 'ordinary text')
        self.page.locator('#paste').fill('literal $x_1$')
        self.page.locator('#paste').select_text()
        self.page.keyboard.press('Control+c')
        self.assertEqual(self.page.evaluate('navigator.clipboard.readText()'), 'literal $x_1$')

    def test_04_partial_formula_selection_restores_whole_source(self):
        self.fixture('<p>before '+katex(display=False)+' after</p>')
        self.page.evaluate('''() => { const n=document.querySelector('.glyph').firstChild; const r=document.createRange(); r.setStart(n,1); r.setEnd(n,3); const s=getSelection(); s.removeAllRanges(); s.addRange(r); }''')
        result = self.payload()
        self.assertEqual(result['text'], '$'+TEX+'$')
        self.assertEqual(result['mathCount'], 1)

    def test_05_inline_display_no_deduplication_of_distinct_equal_formulas(self):
        self.fixture('<p>'+katex('x_1',False)+' plus '+katex('x_1',False)+'</p>'+katex('y_2'))
        self.select()
        result = self.payload()
        self.assertEqual(result['mathCount'], 3)
        self.assertEqual(result['text'], '$x_1$ plus $x_1$\n\n$$\ny_2\n$$')

    def test_06_delimiters_and_escaped_underscore_preserved(self):
        self.fixture(r'<p><span data-latex="\(G_k\)">Gk</span> <span data-latex="\(G\_k\)">G_k</span></p>')
        self.select()
        self.assertEqual(self.payload()['text'], r'$G_k$ $G\_k$')

    def test_07_code_whitespace_and_markdown_structure(self):
        self.fixture('<h2>Heading</h2><p><strong>bold</strong> <a href="https://example.org">link</a> '+katex('x_i',False)+'</p><pre><code class="language-python">if x:\n    print("x_1")\n\n\n    return x\n</code></pre>')
        self.select()
        text = self.payload()['text']
        self.assertIn('## Heading', text)
        self.assertIn('**bold** [link](https://example.org) $x_i$', text)
        self.assertIn('```python\nif x:\n    print("x_1")\n\n\n    return x\n```', text)

    def test_08_fenced_example_is_not_rendered_math(self):
        self.fixture('<pre><code>'+katex('fake')+'</code></pre>')
        self.select()
        self.assertEqual(self.payload()['mathCount'], 0)

    def test_09_mathml_and_mathjax_attribute_containers(self):
        self.fixture(r'<p><math alttext="x_1"><mi>x</mi></math></p><div data-latex="\[y_2\]"><mjx-container display="true"><span>y</span></mjx-container></div>')
        self.select()
        self.assertEqual(self.payload()['text'], '$x_1$\n\n$$\ny_2\n$$')

    def test_10_no_fabricated_tex_from_spoken_aria_or_non_tex_annotation(self):
        self.fixture('<math aria-label="x squared"><semantics><mi>x</mi><annotation encoding="application/mathml+xml">not latex</annotation></semantics></math>')
        self.select()
        self.assertEqual(self.payload()['mathCount'], 0)

    def test_11_streaming_sources_not_stale(self):
        self.fixture('<span data-latex="x_1">x</span>')
        self.select()
        self.assertEqual(self.payload()['text'], '$x_1$')
        self.page.evaluate('document.querySelector("[data-latex]").setAttribute("data-latex", "x_2")')
        self.assertEqual(self.payload()['text'], '$x_2$')
        self.assertEqual(self.page.evaluate('__metrics.formulaWrites'), 0)

    def test_12_quote_mode_opt_in_reversible_and_clone_untouched(self):
        self.fixture(katex('x_1',False))
        self.select()
        self.page.evaluate('OmniGPTClipboard.setQuoteCompatibility(true)')
        self.assertEqual(self.page.evaluate('getSelection().toString()'), '$x_1$')
        self.assertEqual(self.page.evaluate('getSelection().getRangeAt(0).toString()'), '$x_1$')
        self.assertTrue(self.page.evaluate('Range.prototype.cloneContents === __originals.clone'))
        self.page.evaluate('OmniGPTClipboard.setQuoteCompatibility(false)')
        self.assertTrue(self.page.evaluate('Range.prototype.toString === __originals.range && Selection.prototype.toString === __originals.selection'))

    def test_13_trusted_types_enforced_and_ui_works(self):
        self.assertTrue(self.page.evaluate('''() => { try { document.createElement('div').innerHTML='<p>x</p>'; return false; } catch(e) { return e instanceof TypeError; } }'''))
        self.page.locator('.omnigpt-launcher').click()
        self.assertTrue(self.page.locator('.omnigpt-panel').is_visible())
        self.page.keyboard.press('Escape')
        self.assertFalse(self.page.locator('.omnigpt-panel').is_visible())
        self.assertEqual(self.errors, [])

    def test_14_long_page_selection_locality(self):
        extra = ''.join('<section data-turn="assistant"><p>'+katex('outside',False)+'</p></section>' for _ in range(3000))
        self.fixture('<p id="small">selected '+katex('x_i',False)+'</p>', extra)
        self.select('#small')
        result = self.page.evaluate('''() => { const samples=[]; let p; for(let i=0;i<100;i++){const start=performance.now(); p=OmniGPTClipboard.selectionPayload(getSelection()); samples.push(performance.now()-start);} return {payload:p,samples}; }''')
        self.assertEqual(result['payload']['text'], 'selected $x_i$')
        self.assertLess(result['payload']['visitedNodes'], 10)
        self.assertEqual(self.page.evaluate('__metrics.mathQueries'), 0)
        print('Long-page small selection:', json.dumps({'surrounding_formulas':3000, 'visited_nodes':result['payload']['visitedNodes'], 'median_ms':statistics.median(result['samples']), 'p95_ms':sorted(result['samples'])[94]}, ensure_ascii=False))

    def test_15_double_click_plain_only(self):
        self.fixture(katex('x_i'))
        self.page.locator('.glyph').dblclick()
        self.assertEqual(self.page.evaluate('navigator.clipboard.readText()'), '$$\nx_i\n$$')
        self.assertEqual(self.page.evaluate('navigator.clipboard.read().then(items => items.flatMap(item => item.types))'), ['text/plain'])

    def test_16_clears_preexisting_rich_formats(self):
        self.fixture(katex('x_i'))
        self.select()
        result = self.page.evaluate('''() => { const dt=new DataTransfer(); dt.setData('text/html','<math>bad</math>'); dt.setData('text/rtf','bad'); const e=new ClipboardEvent('copy',{clipboardData:dt,cancelable:true,bubbles:true}); document.querySelector('#case').dispatchEvent(e); return {types:[...dt.types],text:dt.getData('text/plain'),canceled:e.defaultPrevented}; }''')
        self.assertEqual(result, {'types':['text/plain'],'text':'$$\nx_i\n$$','canceled':True})

    def test_17_example_payload_exactly_once(self):
        self.fixture('<p>其中：</p>'+katex()+'<p>即“当前所有没有被剩余 layer 遮挡的层”。</p>')
        self.select()
        self.assertEqual(self.payload()['text'], '其中：\n\n$$\n'+TEX+'\n$$\n\n即“当前所有没有被剩余 layer 遮挡的层”。')
        self.assertEqual(self.payload()['mathCount'], 1)

    def test_18_blockquote_math_lines_keep_quote_prefix(self):
        self.fixture('<blockquote><p>quoted</p>'+katex('x_i')+'</blockquote>')
        self.select()
        self.assertIn('> $$\n> x_i\n> $$', self.payload()['text'])

    def test_19_table_with_inline_math(self):
        self.fixture('<table><tr><th>Name</th><th>Value</th></tr><tr><td>cell</td><td>'+katex('x_i',False)+'</td></tr></table>')
        self.select()
        self.assertEqual(self.payload()['text'], '| Name | Value |\n| --- | --- |\n| cell | $x_i$ |')

    def test_20_quote_option_persists_without_default_patching(self):
        self.fixture(katex('x_1',False))
        self.page.locator('.omnigpt-launcher').click()
        checkbox = self.page.locator('.omnigpt-setting input')
        self.assertFalse(checkbox.is_checked())
        checkbox.check()
        self.assertTrue(self.page.evaluate('OmniGPTClipboard.quoteCompatibility'))
        checkbox.uncheck()
        self.assertFalse(self.page.evaluate('OmniGPTClipboard.quoteCompatibility'))
        self.assertTrue(self.page.evaluate('Range.prototype.toString === __originals.range'))

if __name__ == '__main__':
    unittest.main(verbosity=2)
