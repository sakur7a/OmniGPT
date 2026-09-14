(function initOmniGPT(global) {
  "use strict";

  if (global.__omniGPTInjected) return;
  global.__omniGPTInjected = true;

  const ROOT_ID = "omnigpt-root";
  const PATCH_KEY = Symbol.for("omnigpt.math-copy.patched");
  const MATH_SELECTOR = ".katex, mjx-container, math, [data-math-source], [data-latex], [data-tex], [data-original-tex]";
  let statusTimer = null;

  function unwrapMathDelimiters(source) {
    let value = String(source || "").trim().replace(/^latex\s*:\s*/i, "");
    if ((value.startsWith("$$") && value.endsWith("$$")) || (value.startsWith("\\[") && value.endsWith("\\]"))) {
      value = value.slice(2, -2);
    } else if ((value.startsWith("$") && value.endsWith("$")) || (value.startsWith("\\(") && value.endsWith("\\)"))) {
      value = value.slice(1, -1);
    }
    return value.trim();
  }

  function asFormulaRoot(element) {
    if (!(element instanceof Element)) return null;
    let root = element.matches(MATH_SELECTOR) ? element : element.closest(MATH_SELECTOR);
    if (!root) return null;
    while (root.parentElement?.matches?.(MATH_SELECTOR)) root = root.parentElement;
    return root;
  }

  function formulaCandidates(root) {
    if (!root) return [];
    const raw = [];
    if (root instanceof Element && root.matches(MATH_SELECTOR)) raw.push(root);
    root.querySelectorAll?.(MATH_SELECTOR).forEach((element) => raw.push(element));
    const unique = [...new Set(raw.map(asFormulaRoot).filter(Boolean))];
    return unique.filter((candidate) => !unique.some((other) => other !== candidate && other.contains(candidate)));
  }

  function findRawTex(element) {
    const root = asFormulaRoot(element) || element;
    if (!(root instanceof Element)) return "";
    const annotation = root.querySelector('annotation[encoding="application/x-tex"], annotation');
    if (annotation?.textContent?.trim()) return unwrapMathDelimiters(annotation.textContent);
    let candidate = root;
    for (let depth = 0; candidate && depth < 7; depth += 1, candidate = candidate.parentElement) {
      for (const attr of ["data-omnigpt-tex", "data-math-source", "data-latex", "data-tex", "data-original-tex", "alttext"]) {
        const value = candidate.getAttribute(attr);
        if (value?.trim()) return unwrapMathDelimiters(value);
      }
    }
    if (root.matches(".katex, math")) {
      const aria = root.getAttribute("aria-label");
      if (aria?.trim()) return unwrapMathDelimiters(aria);
    }
    return "";
  }

  function isDisplayMath(element) {
    const root = asFormulaRoot(element) || element;
    const cached = root?.getAttribute?.("data-omnigpt-display");
    if (cached === "1" || cached === "0") return cached === "1";
    return Boolean(
      root?.closest?.(".katex-display") ||
      root?.matches?.("mjx-container[display='true'], math[display='block']") ||
      root?.closest?.("[data-math-display='true'], .math-display")
    );
  }

  function formatTex(element) {
    const source = findRawTex(element);
    if (!source) return "";
    return isDisplayMath(element) ? `\n$$\n${source}\n$$\n` : `$${source}$`;
  }

  function cacheFormula(element) {
    const root = asFormulaRoot(element);
    if (!root || root.hasAttribute("data-omnigpt-tex")) return;
    const source = findRawTex(root);
    if (!source) return;
    root.setAttribute("data-omnigpt-tex", source);
    root.setAttribute("data-omnigpt-display", isDisplayMath(root) ? "1" : "0");
  }

  function cacheFormulas(root) { formulaCandidates(root).forEach(cacheFormula); }

  function transformMath(fragment) {
    if (!fragment?.querySelectorAll) return { fragment, changed: false };
    let changed = false;
    formulaCandidates(fragment).forEach((element) => {
      const tex = formatTex(element);
      if (!tex || !element.parentNode) return;
      element.replaceWith(fragment.ownerDocument.createTextNode(tex));
      changed = true;
    });
    return { fragment, changed };
  }

  function rangeContainsFormula(range) {
    const ancestor = range.commonAncestorContainer;
    const root = ancestor.nodeType === 1 ? ancestor : ancestor.parentElement;
    if (!root) return false;
    return formulaCandidates(root).some((element) => {
      try { return range.intersectsNode(element) && Boolean(findRawTex(element)); }
      catch (_) { return false; }
    });
  }

  function patchSelectionSerialization() {
    const rangePrototype = global.Range?.prototype;
    if (!rangePrototype || rangePrototype[PATCH_KEY]) return;
    const nativeCloneContents = rangePrototype.cloneContents;
    const nativeToString = rangePrototype.toString;
    rangePrototype.cloneContents = function omniGPTCloneContents() {
      const fragment = nativeCloneContents.call(this);
      try { return transformMath(fragment).fragment; }
      catch (error) { console.warn("[OmniGPT] Unable to serialize a formula selection.", error); return fragment; }
    };
    rangePrototype.toString = function omniGPTRangeToString() {
      try {
        const result = transformMath(nativeCloneContents.call(this));
        if (result.changed) return result.fragment.textContent || "";
      } catch (error) { console.warn("[OmniGPT] Unable to convert a formula selection to text.", error); }
      return nativeToString.call(this);
    };
    Object.defineProperty(rangePrototype, PATCH_KEY, { value: true });

    const selectionPrototype = global.Selection?.prototype;
    if (selectionPrototype && !selectionPrototype[PATCH_KEY]) {
      const nativeSelectionToString = selectionPrototype.toString;
      selectionPrototype.toString = function omniGPTSelectionToString() {
        try {
          const ranges = Array.from({ length: this.rangeCount }, (_, index) => this.getRangeAt(index));
          if (ranges.some(rangeContainsFormula)) return ranges.map((range) => range.toString()).join("\n");
        } catch (error) { console.warn("[OmniGPT] Unable to convert the quoted selection.", error); }
        return nativeSelectionToString.call(this);
      };
      Object.defineProperty(selectionPrototype, PATCH_KEY, { value: true });
    }
  }

  function selectedTextWithTex(selection) {
    const parts = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
      parts.push(selection.getRangeAt(index).cloneContents().textContent || "");
    }
    return parts.join("\n").replace(/\u200b/g, "");
  }

  async function writeClipboard(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "omnigpt-toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    global.setTimeout(() => {
      toast.classList.add("omnigpt-toast-out");
      global.setTimeout(() => toast.remove(), 180);
    }, 1100);
  }

  function setupMathCopy() {
    cacheFormulas(document);
    const observer = new MutationObserver((mutations) => mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
      if (node.nodeType === 1) cacheFormulas(node);
    })));
    observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener("copy", (event) => {
      const selection = global.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
      if (!ranges.some(rangeContainsFormula)) return;
      const text = selectedTextWithTex(selection);
      if (!text || !event.clipboardData) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", text);
    }, true);

    document.addEventListener("dblclick", (event) => {
      const target = event.target instanceof Element ? asFormulaRoot(event.target) : null;
      const tex = target ? formatTex(target).trim() : "";
      if (!tex) return;
      event.preventDefault();
      writeClipboard(tex).then(() => showToast("LaTeX 公式已复制")).catch(() => showToast("复制失败，请检查剪贴板权限"));
    });
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #${ROOT_ID}{position:fixed;right:18px;bottom:18px;z-index:2147483000;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#e7e7e7}
      #${ROOT_ID} *{box-sizing:border-box}.omnigpt-launcher{display:flex;align-items:center;justify-content:center;gap:8px;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:#111;color:#fff;padding:10px 16px;font-weight:700;box-shadow:0 10px 30px rgba(0,0,0,.25);cursor:pointer;transition:background-color .16s,border-color .16s,transform .16s}.omnigpt-launcher:hover{background:#1b1b1b;border-color:rgba(255,255,255,.28)}.omnigpt-launcher:focus-visible{outline:2px solid #8ee3ad;outline-offset:3px}.omnigpt-mark{display:none;font-size:15px;font-weight:800;line-height:1}.omnigpt-panel{position:absolute;right:0;bottom:48px;width:280px;padding:14px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:rgba(20,20,20,.96);box-shadow:0 18px 50px rgba(0,0,0,.34);backdrop-filter:blur(16px)}.omnigpt-panel[hidden]{display:none}.omnigpt-title{font-size:15px;font-weight:750;margin:0 0 2px}.omnigpt-hint{font-size:11px;color:#999;margin-bottom:12px}.omnigpt-section{font-size:11px;color:#aaa;margin:12px 0 6px;text-transform:uppercase;letter-spacing:.08em}.omnigpt-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.omnigpt-action{border:1px solid #3a3a3a;border-radius:9px;background:#262626;color:#f3f3f3;padding:8px 7px;font-size:12px;cursor:pointer}.omnigpt-action:hover{background:#343434;border-color:#555}.omnigpt-action:disabled{cursor:wait;opacity:.5}.omnigpt-status{min-height:18px;margin-top:10px;font-size:11px;color:#9bd1a8;line-height:1.35}.omnigpt-status[data-error="true"]{color:#ff9b9b}.omnigpt-toast{position:fixed;left:50%;bottom:10%;z-index:2147483647;transform:translateX(-50%);padding:9px 15px;border-radius:999px;background:rgba(15,15,15,.9);color:#fff;font:12px ui-sans-serif,system-ui;transition:opacity .18s}.omnigpt-toast-out{opacity:0}
      @media (max-width:1100px){#${ROOT_ID}{right:10px;top:50%;bottom:auto;transform:translateY(-50%)}.omnigpt-launcher{width:40px;height:40px;padding:0;box-shadow:0 8px 24px rgba(0,0,0,.3)}.omnigpt-mark{display:block}.omnigpt-label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.omnigpt-panel{right:50px;top:50%;bottom:auto;transform:translateY(-50%);max-height:calc(100vh - 24px);overflow:auto}}
      @media (max-width:370px){.omnigpt-panel{width:calc(100vw - 70px)}}@media (prefers-reduced-motion:reduce){.omnigpt-launcher{transition:none}}
    `;
    document.head.appendChild(style);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function createButton(label, attributes) {
    const button = element("button", "omnigpt-action", label);
    button.type = "button";
    Object.entries(attributes).forEach(([key, value]) => { button.dataset[key] = value; });
    return button;
  }

  function createUiTree() {
    const root = element("div");
    root.id = ROOT_ID;
    const launcher = element("button", "omnigpt-launcher");
    launcher.type = "button";
    launcher.setAttribute("aria-label", "打开 OmniGPT");
    launcher.setAttribute("aria-expanded", "false");
    const mark = element("span", "omnigpt-mark", "O");
    mark.setAttribute("aria-hidden", "true");
    launcher.append(mark, element("span", "omnigpt-label", "OmniGPT"));

    const panel = element("div", "omnigpt-panel");
    panel.hidden = true;
    panel.append(element("div", "omnigpt-title", "导出 ChatGPT 对话"), element("div", "omnigpt-hint", "双击公式可单独复制 LaTeX"));

    panel.appendChild(element("div", "omnigpt-section", "当前对话"));
    const current = element("div", "omnigpt-grid");
    current.dataset.current = "";
    [["Markdown", "markdown"], ["JSON", "json"], ["TXT", "txt"], ["GPT 导入包", "gptbundle"]]
      .forEach(([label, format]) => current.appendChild(createButton(label, { format, scope: "current" })));
    current.appendChild(createButton("复制 Markdown", { copy: "markdown" }));
    panel.appendChild(current);

    panel.appendChild(element("div", "omnigpt-section", "全部对话"));
    const all = element("div", "omnigpt-grid");
    all.dataset.all = "";
    [["Markdown 归档", "markdown"], ["JSON 归档", "json"], ["TXT 归档", "txt"], ["GPT 导入包", "gptbundle"]]
      .forEach(([label, format]) => all.appendChild(createButton(label, { format, scope: "all" })));
    panel.appendChild(all);

    const status = element("div", "omnigpt-status");
    status.setAttribute("aria-live", "polite");
    panel.appendChild(status);
    root.append(launcher, panel);
    return { root, launcher, panel };
  }

  function setStatus(message, isError = false) {
    const status = document.querySelector(`#${ROOT_ID} .omnigpt-status`);
    if (!status) return;
    status.textContent = message;
    status.dataset.error = isError ? "true" : "false";
    global.clearTimeout(statusTimer);
    statusTimer = global.setTimeout(() => { status.textContent = ""; delete status.dataset.error; }, 4000);
  }

  function downloadPayload(payload) {
    if (payload.files?.length) {
      payload.files.forEach((file) => global.ChatGPTExporter.createDownload(file.content, file.filename, file.mimeType));
      return payload.detail || `已下载 ${payload.files.length} 个文件`;
    }
    global.ChatGPTExporter.createDownload(payload.content, payload.filename, payload.mimeType);
    return payload.filename;
  }

  async function currentPayload(format) {
    if (global.ChatGPTExporter.getCurrentExportPayload) return global.ChatGPTExporter.getCurrentExportPayload(format, document);
    return global.ChatGPTExporter.getExportPayload(format, document);
  }

  async function runExport(format, scope) {
    const payload = scope === "all" ? await global.ChatGPTExporter.getArchiveExportPayload(format) : await currentPayload(format);
    return downloadPayload(payload);
  }

  function setupUi() {
    if (document.getElementById(ROOT_ID) || !global.ChatGPTExporter) return;
    injectStyles();
    const { root, launcher, panel } = createUiTree();
    document.body.appendChild(root);

    launcher.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      launcher.setAttribute("aria-expanded", String(!panel.hidden));
    });

    root.addEventListener("click", async (event) => {
      const button = event.target.closest?.("button[data-format], button[data-copy]");
      if (!button) return;
      root.querySelectorAll(".omnigpt-action").forEach((item) => { item.disabled = true; });
      try {
        if (button.dataset.copy) {
          const payload = await currentPayload("markdown");
          await writeClipboard(payload.content);
          setStatus("Markdown 已复制");
        } else {
          const isArchive = button.dataset.scope === "all";
          setStatus(isArchive ? "正在读取全部历史对话…" : "正在导出当前对话…");
          setStatus(`完成：${await runExport(button.dataset.format, button.dataset.scope)}`);
        }
      } catch (error) {
        console.error("[OmniGPT] Export failed.", error);
        setStatus(error?.message || "导出失败", true);
      } finally {
        root.querySelectorAll(".omnigpt-action").forEach((item) => { item.disabled = false; });
      }
    });

    document.addEventListener("click", (event) => {
      if (!root.contains(event.target)) {
        panel.hidden = true;
        launcher.setAttribute("aria-expanded", "false");
      }
    });
  }

  patchSelectionSerialization();
  function start() { setupMathCopy(); setupUi(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})(globalThis);
