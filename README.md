<p align="right"><a href="README_ZH.md">简体中文</a> · <strong>English</strong></p>

<div align="center">

<h1>OmniGPT</h1>

<p><strong>Archive your chats. Keep your math editable.</strong></p>
<p>A lightweight userscript for exporting ChatGPT conversations and copying LaTeX reliably.</p>

<p>
  <a href="https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js"><strong>Install Script</strong></a>
  &nbsp; · &nbsp;
  <a href="https://greasyfork.org/en/scripts/590463-omnigpt-chatgpt-export-latex-copy">Greasy Fork</a>
  &nbsp; · &nbsp;
  <a href="#getting-started">Usage</a>
  &nbsp; · &nbsp;
  <a href="https://github.com/sakur7a/OmniGPT/releases">Releases</a>
</p>

<p>
  <a href="https://github.com/sakur7a/OmniGPT/releases/latest"><img src="https://img.shields.io/github/v/release/sakur7a/OmniGPT?style=flat-square&label=release&color=59636e" alt="Latest GitHub release"></a>
  <a href="https://github.com/sakur7a/OmniGPT/actions/workflows/build-userscript.yml"><img src="https://img.shields.io/github/actions/workflow/status/sakur7a/OmniGPT/build-userscript.yml?branch=main&style=flat-square&label=checks" alt="Main branch build and test status"></a>
</p>

</div>

<p align="center">
  <img src="docs/assets/readme-preview.webp" width="820" alt="OmniGPT 0.3.0 panel in light and dark themes, showing export scope, file format, advanced options, export and copy actions">
</p>
<p align="center"><sub>OmniGPT 0.3.0 panel · local demo environment · advanced options expanded on demand</sub></p>

**Conversation export** — Export the current chat or conversation history as Markdown, JSON or TXT, or split long histories into reference-material chunks.<br>
**Math fidelity** — Copy the original TeX source, preserving inline vs. display math without carrying KaTeX / MathML render fragments.<br>
**On-demand runtime** — No continuous page scanning by default. Math is processed when you copy it, exports run only when requested, and the full panel is created only when first opened.

## Getting started

1. Install [Tampermonkey](https://www.tampermonkey.net/) or another compatible userscript manager.
2. Open the **[GitHub install URL](https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js)** and confirm installation. You can also install from [Greasy Fork](https://greasyfork.org/en/scripts/590463-omnigpt-chatgpt-export-latex-copy); use the version actually published there.
3. Reload ChatGPT. Click **OmniGPT** in the lower-right corner; on narrow layouts it collapses into an **O** button on the right side.

> After updating the userscript, reload any ChatGPT tabs that were already open before copying again. Keep only one OmniGPT installation enabled.

## Copy math without losing the source

Select a response containing formulas and copy it to get **plain-text Markdown with editable TeX**, instead of an image or fragments from the rendered formula tree.

| Action | Result |
| :--- | :--- |
| Select text, then `Ctrl+C` / `⌘C` | Copies the selection while preserving formulas, code and basic Markdown structure |
| Double-click a formula | Copies the complete formula while preserving whether it was inline or display math |
| `Alt` / `Option` + double-click | Copies raw TeX only, without delimiters, for pasting into an existing math environment |

For example, a response containing inline and display math is copied as:

```markdown
Let the sequence be $x_1, \ldots, x_n$. Its mean is:

$$
\bar{x} = \frac{1}{n} \sum_{k=1}^{n} x_k
$$
```

Under **More options → Formula copy**, you can switch to LaTeX delimiters `\(…\)` / `\[…\]`. Normal text selections and copying inside input fields remain native. The optional **Quote compatibility** mode is off by default and is only needed when you want ChatGPT's native selection-to-quote flow to preserve TeX as well.

<details>
<summary>Math-copy behavior and edge cases</summary>

- Selecting only part of a rendered formula still restores the full TeX for that formula, without expanding surrounding prose outside the selection.
- `G_k` and `G\_k` keep their original meaning; OmniGPT does not rewrite one into the other. If no reliable TeX source is available, spoken accessibility text is not guessed as TeX.
- The formula-copy setting affects rendered formulas. API exports preserve the source text and its existing delimiters instead of running regex replacements across the whole document.
- ChatGPT's native response-copy button may bypass the browser `copy` event. For predictable output, use selection copy, double-click, or **Copy Markdown** in the OmniGPT panel.

See [current formula rules and design notes](docs/V0.3.0.md) for details.

</details>

## Export conversations by scope and format

Open the panel, choose an **Export scope** and **File format**, then click **Export file**. If you only want to move the current conversation into notes or another chat, use **Copy Markdown**.

| Format | Best for |
| :--- | :--- |
| **Markdown** `.md` | Notes, knowledge bases and version control; keeps formulas and code in the body |
| **JSON** `.json` | Programmatic processing; keeps structured content, source information and warnings |
| **TXT** `.txt` | Plain-text reading and search; Markdown syntax already present in API text may remain |
| **Reference chunks** `.md` | Splitting long histories into uploadable reference files at message boundaries |

For the current conversation, OmniGPT prefers the API representation of the active branch and falls back to the already-loaded page if needed. You can also choose offline page capture under **More options**. History export can use everything returned by the current conversation list or be limited to the most recent **50 / 200** items.

During export, the panel shows progress plus success and failure counts. You can cancel the task, and closing the panel also cancels an in-progress read. When a reference bundle produces multiple parts, they are saved individually rather than triggering a burst of automatic downloads.

> **An export is not a complete account backup.** Page capture can miss messages that are not loaded in the DOM; history coverage depends on what the current account list returns; images and attachments are represented by available references or placeholders rather than bundled binary files. Read failures and completeness warnings are preserved in exported results.

## Lightweight by default, data stays local

OmniGPT has no ads, analytics, telemetry or third-party uploads. Copying does not call the backend and does not read your clipboard. Export requests go only to the current ChatGPT site, and generated files are created locally in the browser.

By default OmniGPT does not install a continuous page observer, poll the page, cache every formula, or globally take over networking, the Clipboard API, or browser selection methods. The UI uses native DOM and CSS with no framework, external font or third-party runtime dependency.

Large history exports still require memory and processing time, so they are not free. For a first large export, trying the most recent 50 conversations is a useful sanity check.

## FAQ

<details>
<summary><strong>GitHub has a newer version. Why does Tampermonkey still say there is no update?</strong></summary>

Check both the installed version and its update source. Installations from GitHub Raw update from this repository; Greasy Fork installations require the corresponding version to be published on Greasy Fork first. **A successful GitHub Release does not mean Greasy Fork has already synced it.**

You can update from the GitHub install link above, verify the version, then reload ChatGPT. Maintainer-only one-time sync setup is documented in [RELEASING.md](docs/RELEASING.md).

</details>

<details>
<summary><strong>Can formatting still change when pasting into Obsidian, WeChat or another editor?</strong></summary>

For supported math selections, OmniGPT writes only `text/plain` so that KaTeX HTML and MathML copies do not get mixed into the clipboard item. The destination editor or one of its plugins may still transform that plain text, so OmniGPT cannot guarantee identical rendering in every paste target.

When debugging, first update OmniGPT, reload the source ChatGPT tab, copy again, and make sure you used a selection copy rather than ChatGPT's native response-copy button. Existing clipboard contents are not retroactively fixed by an update.

</details>

<details>
<summary><strong>Can JSON exports or reference chunks restore native ChatGPT history?</strong></summary>

No. JSON is a normalized conversation export, and reference chunks are Markdown files intended for model-readable context. Neither is a native ChatGPT restore format. DOM fallback, list coverage and attachment handling can also affect completeness.

</details>

<details>
<summary><strong>Which browsers are supported, and how should I report an issue?</strong></summary>

The primary target is Chrome / Edge with Tampermonkey. The script matches `chatgpt.com` and the legacy `chat.openai.com` host and does not inject into subframes. Automated regressions use Chromium with representative page fixtures and mocked APIs; that is not the same as full end-to-end coverage for desktop apps, authenticated ChatGPT, Firefox or Violentmonkey.

Please open a [GitHub Issue](https://github.com/sakur7a/OmniGPT/issues) with the OmniGPT version, browser version, exact steps and redacted error output. **Do not post access tokens, session cookies or private conversations.**

</details>

## Development and documentation

[Current behavior and tradeoffs](docs/V0.3.0.md) · [Clipboard and performance notes](docs/CLIPBOARD.md) · [Release and sync workflow](docs/RELEASING.md)

<details>
<summary>Local build and tests</summary>

Node.js 24 is recommended to match CI. Edit files under `src/`; do not edit the generated `OmniGPT.user.js` directly.

```bash
git clone https://github.com/sakur7a/OmniGPT.git
cd OmniGPT
npm run check       # build, metadata verification, syntax checks and Node regressions
```

Browser tests are development-only and are not bundled into the userscript. After creating and activating a Python virtual environment:

```bash
python -m pip install playwright==1.57.0
python -m playwright install chromium
python test/browser-regression.py
python test/browser-v030.py
```

Core files: `src/clipboard.js` handles copying, `src/exporter.js` handles collection and export, and `src/omnigpt.js` owns the panel. CI runs both Node and browser regressions before a release is published.

</details>

---

### Credits and license

The export logic was adapted from an earlier `chatgpt-exporter` project. LaTeX compatibility ideas were informed by ChatGPT Better TeX Quote (schweigen, MIT) and TexCopyer (yjy / blime, GPL-3.0). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for full details.

[GPL-3.0-or-later](LICENSE) · [Report an issue](https://github.com/sakur7a/OmniGPT/issues) · [Releases](https://github.com/sakur7a/OmniGPT/releases)
