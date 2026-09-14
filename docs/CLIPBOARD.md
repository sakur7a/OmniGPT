# Clipboard behavior and lightweight mode (0.2.1)

## Why pasting into different applications differed

A browser clipboard can carry both `text/plain` and `text/html`. KaTeX normally includes visual HTML and accessibility MathML; the latter can also contain a TeX annotation. An HTML-to-Markdown importer can accidentally combine representations, or convert a math container into a fenced `math` block. This is consistent with the reported WeChat / Obsidian / ChatGPT paste differences, but we did not inspect the user's actual clipboard or those applications' internal paste handlers.

The previous copy handler wrote only `text/plain`, called `preventDefault()`, and allowed subsequent event listeners to run. Canceling the default action does not stop other listeners from adding HTML. The previous unconditional Range/Selection prototype patches also changed how the website serialized selections outside an explicit copy action.

0.2.1 handles a supported formula selection at window capture, clears existing event clipboard representations, writes **only `text/plain`**, then cancels the default action and stops later listeners for that copy event. It does not supply `text/html`, MathML, KaTeX render trees, or math code fences. No-formula selections and editable controls retain native copy behavior.

References: [W3C Clipboard API](https://www.w3.org/TR/clipboard-apis/#override-copy), [KaTeX output options](https://katex.org/docs/options).

## Output contract

```markdown
其中：

$$
G_k = \text{当前 occlusion frontier}
$$

即“当前所有没有被剩余 layer 遮挡的层”。
```

Inline formulas use `$...$`; display formulas use `$$` on separate lines. TeX is protected from Markdown escaping: `G_k` stays `G_k`. An intentional literal underscore `G\_k` is preserved, not silently changed into a subscript. Selecting part of a rendered formula copies that intersected formula's full TeX; text outside the selection is not included. Code examples are not treated as rendered formulas. Code whitespace, headings, links, lists, quotes and basic tables are serialized as Markdown when the selection contains supported math.

Only actual TeX sources are used: data attributes, TeX-encoded annotations, or an already available MathJax source API. Spoken `aria-label` values and arbitrary XML annotations are not guessed to be TeX. Complex merged-cell tables, image-only selections and renderers that expose no TeX source are not guaranteed to round-trip.

## Runtime cost

The default mode does not create a MutationObserver, poll the page, listen to `selectionchange`, cache every formula in DOM attributes, intercept fetch/XHR, read the clipboard, or patch Range/Selection/Clipboard prototypes. There is no initial formula scan. Formula processing runs only for an explicit copy or double-click, on the selected subtree / clicked formula. Traversal prunes nodes outside the selection and skips a formula's descendants after extracting its source, avoiding all-pairs formula deduplication. Export API requests remain user-triggered via the export panel.

The panel adds a small set of event listeners; creating it still has a nonzero one-time cost. These structural changes do not constitute a guarantee of zero overhead or a measured live-ChatGPT FPS improvement.

## Optional quote compatibility

In the panel, **引用兼容（默认关闭）** enables scoped `Range.toString` / `Selection.toString` wrappers. Only supported math selections inside messages change. `Range.cloneContents` is never patched. Disabling the option restores methods still owned by OmniGPT and does not overwrite another extension's later modifications. The setting is stored locally. Quote integrations that do not use these text methods may still use their own formatting.

Ctrl+C, double-click copy and OmniGPT's Copy Markdown action do not require this option. If performance and isolation matter most, leave it off. This default differs intentionally from 0.2.0's unconditional quote patches.

## Tests and limitations

`npm run check` runs build, metadata, syntax and Node regression tests. CI also runs `test/browser-regression.py` with Chromium **before publishing**. Browser tests use real copy/paste keyboard events and the system clipboard for MIME/content checks, plus DOM fixtures for partial selections, duplicate render layers, stale sources, Trusted Types, code indentation, quote toggling, basic tables and long-page traversal. The 3000-formula locality case records visited nodes and timing; it is not a whole-app latency benchmark. Playwright is test-only and is not bundled into the userscript.

These tests do not launch desktop WeChat, desktop Obsidian or a logged-in ChatGPT session. Destination plugins and editors can still transform plain text. Native response-copy buttons that write directly through their own Clipboard API do not necessarily dispatch a copy event; OmniGPT deliberately does not globally override that API. Use selection Ctrl+C, double-click, or the OmniGPT Copy Markdown action for the controlled output path.

After upgrading, **reload existing ChatGPT tabs**, then copy the content again. Updating the installed script does not remove old listeners or prototypes from an already running tab, nor does it repair a clipboard item copied before upgrading. Keep only one OmniGPT installation enabled.
