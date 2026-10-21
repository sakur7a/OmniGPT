"""Current ChatGPT DOM fixtures, captured from Edge on 2026-10-21.

Real Chromium keyboard/clipboard, simulated message DOM; not authenticated E2E.
Run: python test/browser-current-dom.py (CHROMIUM_PATH may select an installed browser).
"""
import html
import os
from pathlib import Path
import unittest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
USERSCRIPT = Path(os.environ.get('OMNIGPT_TEST_SCRIPT', ROOT/'OmniGPT.user.js'))
ORIGIN = 'http://localhost:18762'
TEX = r'5\leq6\leq7'

def formula(tex=TEX, display=False):
    return (f'<span data-math-source="{html.escape(tex, quote=True)}" '
            f'data-math-display="{str(display).lower()}"><span class="katex">'
            '<span class="katex-html" aria-hidden="true">5≤6≤7</span>'
            f'<annotation encoding="application/x-tex">{html.escape(tex)}</annotation></span></span>')

def assistant(body, index=2):
    return (f'<div data-content-search-unit-key="fallback-turn-0:{index}:assistant">'
            f'<div data-markdown-text-style="assistant-message" id="case{index}">{body}</div></div>')

class CurrentDOMTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'))
        print('Fixture Chromium', cls.browser.version)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.context = self.browser.new_context(permissions=['clipboard-read', 'clipboard-write'])
        self.page = self.context.new_page()
        self.body = ''
        self.context.route(ORIGIN+'/**', self.serve)
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))

    def tearDown(self):
        self.assertEqual(self.errors, [])
        self.context.close()

    def serve(self, route):
        if route.request.url.endswith('/script.js'):
            route.fulfill(content_type='text/javascript', body=USERSCRIPT.read_text(encoding='utf-8'))
        else:
            route.fulfill(content_type='text/html', body='<!doctype html><meta charset="utf-8">'
                          '<script src="/script.js"></script><div id="thread">'+self.body+'</div><textarea id="paste"></textarea>')

    def fixture(self, body, extra='', full=False, legacy=False):
        self.body = ('<div data-talvt-turn-state="complete">'
                     '<div data-content-search-unit-key="fallback-turn-0:0:user"><p>USER MUST NOT BE COPIED</p></div>'
                     '<div data-content-search-unit-key="fallback-turn-0:1:analysis"><p>REASONING MUST NOT BE COPIED</p></div>'
                     +(body if full else assistant(body))+extra+
                     '<div class="turn-action-controls"><span><button aria-label="复制" id="reply"><svg><path/></svg></button></span>'
                     '<button aria-label="分享" id="other">Other</button></div></div>')
        if legacy:
            content = body if full else '<div class="markdown" id="case2">'+body+'</div>'
            self.body = ('<main><section data-testid="conversation-turn-0" data-turn="assistant">'+content+
                         '<button data-testid="copy-turn-action-button" id="reply">Copy</button>'
                         '<button id="other">Other</button></section></main>')
        self.page.goto(ORIGIN+'/c/current-dom')
        self.page.evaluate("""() => {window.nativeClicks=0; for (const id of ['reply','other'])
          document.getElementById(id).addEventListener('click',()=>{nativeClicks++;void navigator.clipboard.writeText('native');});} """)

    def select(self, selector='#case2'):
        self.page.evaluate('''s=>{const r=document.createRange();r.selectNodeContents(document.querySelector(s));
            getSelection().removeAllRanges();getSelection().addRange(r);}''', selector)

    def clipboard(self):
        # Windows' Clipboard API writes use CRLF. Compare text after OS newline canonicalization.
        return self.page.evaluate('navigator.clipboard.readText()').replace('\r\n', '\n')

    def both_paths(self, expected):
        self.select()
        self.page.keyboard.press('Control+c')
        self.assertEqual(self.clipboard(), expected)
        self.page.locator('#reply').click()
        self.assertEqual(self.clipboard(), expected)
        self.assertEqual(self.page.evaluate('nativeClicks'), 0)
        self.assertEqual(self.page.evaluate('navigator.clipboard.read().then(xs=>xs.flatMap(x=>x.types))'), ['text/plain'])

    def test_01_current_inline_keyboard_and_reply_button(self):
        self.fixture('<p>Result '+formula()+' done.</p>')
        self.both_paths('Result $'+TEX+'$ done.')

    def test_02_current_display_keyboard_and_reply_button(self):
        self.fixture('<p>Before</p>'+formula(display=True)+'<p>After</p>')
        self.both_paths('Before\n\n$$\n'+TEX+'\n$$\n\nAfter')

    def test_03_multiple_assistant_blocks_exclude_user_reasoning_and_other_turns(self):
        self.fixture(assistant('<p>First '+formula()+'</p>')+assistant('<p>Second '+formula('y_i')+'</p>', 3),
                     full=True)
        self.page.locator('#reply').click()
        self.assertEqual(self.clipboard(), 'First $'+TEX+'$\n\nSecond $y_i$')

    def test_04_raw_math_in_prose_with_unrelated_code(self):
        self.fixture(r'<p>Result \(5\leq6\leq7\)</p><p>Block \[x_i\]</p>'
                     r'<p>Literal <code>\(z_i\)</code></p><pre><code class="language-python">s = "\(x_i\)"</code></pre>')
        expected = 'Result $'+TEX+'$\n\nBlock\n\n$$\nx_i\n$$\n\nLiteral `\\(z_i\\)`\n\n```python\ns = "\\(x_i\\)"\n```'
        self.both_paths(expected)

    def test_05_rendered_and_raw_math_share_one_reply(self):
        self.fixture('<p>'+formula()+r' plus \(x_i\).</p><p>\[y_i\]</p><pre><code>\(literal\)</code></pre>')
        self.both_paths('$'+TEX+'$ plus $x_i$.\n\n$$\ny_i\n$$\n\n```\n\\(literal\\)\n```')

    def test_06_plain_code_editors_and_unknown_buttons_remain_native(self):
        for body in ('<p>ordinary text</p>', r'<pre><code>\(literal\)</code></pre>'):
            with self.subTest(body=body):
                self.fixture(body)
                self.select()
                self.page.keyboard.press('Control+c')
                self.assertIn('ordinary text' if 'ordinary' in body else r'\(literal\)', self.clipboard())
                self.page.locator('#reply').click()
                self.assertEqual(self.clipboard(), 'native')
        self.fixture(formula())
        self.page.locator('#other').click()
        self.assertEqual(self.clipboard(), 'native')
        self.page.locator('#paste').fill(r'\(editor\)')
        self.page.locator('#paste').select_text()
        self.page.keyboard.press('Control+c')
        self.assertEqual(self.clipboard(), r'\(editor\)')

    def test_07_unselected_code_in_common_ancestor_does_not_disable_math(self):
        self.fixture(r'<p id="start">Selected \(x_i\)</p><p id="end">end</p><pre><code>\(unselected\)</code></pre>')
        self.page.evaluate('''()=>{const r=document.createRange();r.setStart(document.querySelector('#start').firstChild,0);
            r.setEnd(document.querySelector('#end').firstChild,3);getSelection().removeAllRanges();getSelection().addRange(r);}''')
        self.page.keyboard.press('Control+c')
        self.assertEqual(self.clipboard(), 'Selected $x_i$\n\nend')

    def test_08_repeat_copy_and_keyboard_activation_are_stable(self):
        self.fixture('<p>'+formula()+r' and \(x_i\)</p>')
        expected = '$'+TEX+'$ and $x_i$'
        for _ in range(3):
            self.both_paths(expected)
        self.page.locator('#reply').focus()
        self.page.keyboard.press('Enter')
        self.assertEqual(self.clipboard(), expected)
        self.assertEqual(self.page.evaluate('(text)=>OmniGPTClipboard.normalizeMarkdownMath(text)', expected), expected)

    def test_09_latex_preference_and_code_copy_button_remain_scoped(self):
        self.fixture('<p>'+formula()+'</p><pre><button aria-label="复制" id="code-copy">copy code</button><code>x</code></pre>')
        self.page.evaluate('OmniGPTClipboard.setMathStyle("latex")')
        self.both_paths(r'\('+TEX+r'\)'+'\n\n```\nx\n```')
        self.page.evaluate("document.getElementById('code-copy').addEventListener('click',()=>navigator.clipboard.writeText('code only'))")
        self.page.locator('#code-copy').click()
        self.assertEqual(self.clipboard(), 'code only')

    def test_10_raw_display_math_preserves_quote_and_list_prefixes(self):
        self.fixture(r'<blockquote><p>Quote</p><p>\[q_i\]</p></blockquote><ol start="3"><li>\[l_i\]</li></ol>')
        self.both_paths('> Quote\n>\n> $$\n> q_i\n> $$\n\n3. $$\n   l_i\n   $$')

    def test_11_legacy_raw_and_rendered_math_with_unrelated_code(self):
        for rendered in ('', formula()+' '):
            with self.subTest(rendered=bool(rendered)):
                self.fixture('<p>'+rendered+r'Raw \(x_i\)</p><pre><code>\(literal\)</code></pre>', legacy=True)
                expected = ('$'+TEX+'$ ' if rendered else '')+'Raw $x_i$\n\n```\n\\(literal\\)\n```'
                self.both_paths(expected)

    def test_12_legacy_unselected_code_does_not_disable_raw_math(self):
        self.fixture(r'<p id="start">Selected \(x_i\)</p><p id="end">end</p><pre><code>\(unselected\)</code></pre>', legacy=True)
        self.page.evaluate('''()=>{const r=document.createRange();r.setStart(document.querySelector('#start').firstChild,0);
            r.setEnd(document.querySelector('#end').firstChild,3);getSelection().removeAllRanges();getSelection().addRange(r);}''')
        self.page.keyboard.press('Control+c')
        self.assertEqual(self.clipboard(), 'Selected $x_i$\n\nend')

    def test_13_multiple_legacy_markdown_blocks_are_not_truncated(self):
        self.fixture('<div class="markdown"><p>First '+formula()+'</p></div>'
                     '<div class="markdown"><p>Second '+formula('y_i')+'</p></div>', full=True, legacy=True)
        self.page.locator('#reply').click()
        self.assertEqual(self.clipboard(), 'First $'+TEX+'$\n\nSecond $y_i$')

if __name__ == '__main__':
    unittest.main(verbosity=2)
