(function initOmniGPT(global) {
  "use strict";

  if (global.__omniGPTInjected) {
    return;
  }
  global.__omniGPTInjected = true;

  const ROOT_ID = "omnigpt-root";
  const PATCH_KEY = Symbol.for("omnigpt.math-copy.patched");
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

  function findRawTex(katexElement) {
    if (!(katexElement instanceof Element)) {
      return "";
    }

    const cached = katexElement.getAttribute("data-omnigpt-tex");
    if (cached?.trim()) {
      return unwrapMathDelimiters(cached);
    }

    const annotation = katexElement.querySelector('annotation[encoding="application/x-tex"], annotation');
    if (annotation?.textContent?.trim()) {
      return unwrapMathDelimiters(annotation.textContent);
    }

    let candidate = katexElement;
    for (let depth = 0; candidate && depth < 6; depth += 1, candidate = candidate.parentElement) {
      for (const attribute of [
        "data-math-source",
        "data-latex",
        "data-tex",
        "data-original-tex",
        "alttext",
        "aria-label"
      ]) {
        const value = candidate.getAttribute(attribute);
        if (value?.trim()) {
          return unwrapMathDelimiters(value);
        }
      }
    }

    return "";
  }

  function isDisplayMath(katexElement) {
    const cached = katexElement.getAttribute("data-omnigpt-display");
    if (cached === "1" || cached === "0") {
      return cached === "1";
    }
    return Boolean(katexElement.closest(".katex-display"));
  }

  function formatTex(katexElement) {
    const source = findRawTex(katexElement);
    if (!source) {
      return "";
    }
    return isDisplayMath(katexElement) ? `\n$$\n${source}\n$$\n` : `$${source}$`;
  }

  function cacheFormula(katexElement) {
    if (!(katexElement instanceof Element) || katexElement.hasAttribute("data-omnigpt-tex")) {
      return;
    }
    const source = findRawTex(katexElement);
    if (!source) {
      return;
    }
    katexElement.setAttribute("data-omnigpt-tex", source);
    katexElement.setAttribute("data-omnigpt-display", katexElement.closest(".katex-display") ? "1" : "0");
  }

  function cacheFormulas(root) {
    if (!root) {
      return;
    }
    if (root instanceof Element && root.matches(".katex")) {
      cacheFormula(root);
    }
    root.querySelectorAll?.(".katex").forEach(cacheFormula);
  }

  function transformMath(fragment) {
    if (!fragment?.querySelectorAll) {
      return { fragment, changed: false };
    }

    let changed = false;
    fragment.querySelectorAll(".katex").forEach((katexElement) => {
      const tex = formatTex(katexElement);
      if (!tex) {
        return;
      }
      katexElement.replaceWith(fragment.ownerDocument.createTextNode(tex));
      changed = true;
    });
    return { fragment, changed };
  }

  function patchSelectionSerialization() {
    const rangePrototype = global.Range?.prototype;
    if (!rangePrototype || rangePrototype[PATCH_KEY]) {
      return;
    }

    const nativeCloneContents = rangePrototype.cloneContents;
    const nativeToString = rangePrototype.toString;

    rangePrototype.cloneContents = function omniGPTCloneContents() {
      const fragment = nativeCloneContents.call(this);
      try {
        return transformMath(fragment).fragment;
      } catch (error) {
        console.warn("[OmniGPT] Unable to serialize a formula selection.", error);
        return fragment;
      }
    };

    rangePrototype.toString = function omniGPTRangeToString() {
      try {
        const result = transformMath(nativeCloneContents.call(this));
        if (result.changed) {
          return result.fragment.textContent || "";
        }
      } catch (error) {
        console.warn("[OmniGPT] Unable to convert a formula selection to text.", error);
      }
      return nativeToString.call(this);
    };

    Object.defineProperty(rangePrototype, PATCH_KEY, { value: true });

    const selectionPrototype = global.Selection?.prototype;
    if (selectionPrototype && !selectionPrototype[PATCH_KEY]) {
      const nativeSelectionToString = selectionPrototype.toString;
      selectionPrototype.toString = function omniGPTSelectionToString() {
        try {
          const ranges = Array.from({ length: this.rangeCount }, (_, index) => this.getRangeAt(index));
          if (ranges.some(rangeContainsFormula)) {
            return ranges.map((range) => range.toString()).join("\n");
          }
        } catch (error) {
          console.warn("[OmniGPT] Unable to convert the quoted selection.", error);
        }
        return nativeSelectionToString.call(this);
      };
      Object.defineProperty(selectionPrototype, PATCH_KEY, { value: true });
    }
  }

  function rangeContainsFormula(range) {
    const ancestor = range.commonAncestorContainer;
    const root = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;
    if (!root) {
      return false;
    }

    const candidates = [];
    const closest = root.closest?.(".katex");
    if (closest) {
      candidates.push(closest);
    }
    root.querySelectorAll?.(".katex").forEach((element) => candidates.push(element));
    return candidates.some((element) => {
      try {
        return range.intersectsNode(element) && Boolean(findRawTex(element));
      } catch (_) {
        return false;
      }
    });
  }

  function selectedTextWithTex(selection) {
    const parts = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      const fragment = range.cloneContents();
      parts.push(fragment.textContent || "");
    }
    return parts.join("\n").replace(/\u200b/g, "");
  }

  async function writeClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

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

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          cacheFormulas(node);
        }
      }));
    });
    observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener("copy", (event) => {
      const selection = global.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        return;
      }

      const hasFormula = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
        .some(rangeContainsFormula);
      if (!hasFormula) {
        return;
      }

      const text = selectedTextWithTex(selection);
      if (!text || !event.clipboardData) {
        return;
      }
      event.preventDefault();
      event.clipboardData.setData("text/plain", text);
    }, true);

    document.addEventListener("dblclick", (event) => {
      const katexElement = event.target instanceof Element ? event.target.closest(".katex") : null;
      const tex = katexElement ? formatTex(katexElement).trim() : "";
      if (!tex) {
        return;
      }
      event.preventDefault();
      writeClipboard(tex)
        .then(() => showToast("LaTeX 公式已复制"))
        .catch(() => showToast("复制失败，请检查剪贴板权限"));
    });
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #${ROOT_ID}{position:fixed;right:18px;bottom:18px;z-index:2147483000;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#e7e7e7}
      #${ROOT_ID} *{box-sizing:border-box}
      .omnigpt-launcher{border:1px solid rgba(255,255,255,.16);border-radius:999px;background:#111;color:#fff;padding:10px 16px;font-weight:700;box-shadow:0 10px 30px rgba(0,0,0,.25);cursor:pointer}
      .omnigpt-panel{position:absolute;right:0;bottom:48px;width:280px;padding:14px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:rgba(20,20,20,.96);box-shadow:0 18px 50px rgba(0,0,0,.34);backdrop-filter:blur(16px)}
      .omnigpt-panel[hidden]{display:none}
      .omnigpt-title{font-size:15px;font-weight:750;margin:0 0 2px}
      .omnigpt-hint{font-size:11px;color:#999;margin-bottom:12px}
      .omnigpt-section{font-size:11px;color:#aaa;margin:12px 0 6px;text-transform:uppercase;letter-spacing:.08em}
      .omnigpt-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
      .omnigpt-action{border:1px solid #3a3a3a;border-radius:9px;background:#262626;color:#f3f3f3;padding:8px 7px;font-size:12px;cursor:pointer}
      .omnigpt-action:hover{background:#343434;border-color:#555}
      .omnigpt-action:disabled{cursor:wait;opacity:.5}
      .omnigpt-status{min-height:18px;margin-top:10px;font-size:11px;color:#9bd1a8;line-height:1.35}
      .omnigpt-status[data-error="true"]{color:#ff9b9b}
      .omnigpt-toast{position:fixed;left:50%;bottom:10%;z-index:2147483647;transform:translateX(-50%);padding:9px 15px;border-radius:999px;background:rgba(15,15,15,.9);color:#fff;font:12px ui-sans-serif,system-ui;transition:opacity .18s}
      .omnigpt-toast-out{opacity:0}
    `;
    document.head.appendChild(style);
  }

  function setStatus(message, isError = false) {
    const status = document.querySelector(`#${ROOT_ID} .omnigpt-status`);
    if (!status) {
      return;
    }
    status.textContent = message;
    status.dataset.error = isError ? "true" : "false";
    global.clearTimeout(statusTimer);
    statusTimer = global.setTimeout(() => {
      status.textContent = "";
      delete status.dataset.error;
    }, 4000);
  }

  function downloadPayload(payload) {
    if (payload.files?.length) {
      payload.files.forEach((file) => global.ChatGPTExporter.createDownload(file.content, file.filename, file.mimeType));
      return payload.detail || `已下载 ${payload.files.length} 个文件`;
    }
    global.ChatGPTExporter.createDownload(payload.content, payload.filename, payload.mimeType);
    return payload.filename;
  }

  async function runExport(format, scope) {
    const payload = scope === "all"
      ? await global.ChatGPTExporter.getArchiveExportPayload(format)
      : global.ChatGPTExporter.getExportPayload(format, document);
    return downloadPayload(payload);
  }

  function createButton(label, attributes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "omnigpt-action";
    button.textContent = label;
    Object.entries(attributes).forEach(([key, value]) => button.dataset[key] = value);
    return button;
  }

  function setupUi() {
    if (document.getElementById(ROOT_ID) || !global.ChatGPTExporter) {
      return;
    }

    injectStyles();
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <button type="button" class="omnigpt-launcher" aria-expanded="false">OmniGPT</button>
      <div class="omnigpt-panel" hidden>
        <div class="omnigpt-title">导出 ChatGPT 对话</div>
        <div class="omnigpt-hint">双击公式可单独复制 LaTeX</div>
        <div class="omnigpt-section">当前对话</div>
        <div class="omnigpt-grid" data-current></div>
        <div class="omnigpt-section">全部对话</div>
        <div class="omnigpt-grid" data-all></div>
        <div class="omnigpt-status" aria-live="polite"></div>
      </div>
    `;

    const current = root.querySelector("[data-current]");
    const all = root.querySelector("[data-all]");
    [["Markdown", "markdown"], ["JSON", "json"], ["TXT", "txt"], ["GPT 导入包", "gptbundle"]]
      .forEach(([label, format]) => current.appendChild(createButton(label, { format, scope: "current" })));
    current.appendChild(createButton("复制 Markdown", { copy: "markdown" }));
    [["Markdown 归档", "markdown"], ["JSON 归档", "json"], ["TXT 归档", "txt"], ["GPT 导入包", "gptbundle"]]
      .forEach(([label, format]) => all.appendChild(createButton(label, { format, scope: "all" })));

    document.body.appendChild(root);
    const launcher = root.querySelector(".omnigpt-launcher");
    const panel = root.querySelector(".omnigpt-panel");

    launcher.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      launcher.setAttribute("aria-expanded", String(!panel.hidden));
    });

    root.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-format], button[data-copy]");
      if (!button) {
        return;
      }

      root.querySelectorAll(".omnigpt-action").forEach((item) => item.disabled = true);
      try {
        if (button.dataset.copy) {
          const payload = global.ChatGPTExporter.getExportPayload("markdown", document);
          await writeClipboard(payload.content);
          setStatus("Markdown 已复制");
        } else {
          const isArchive = button.dataset.scope === "all";
          setStatus(isArchive ? "正在读取全部历史对话…" : "正在导出当前对话…");
          const detail = await runExport(button.dataset.format, button.dataset.scope);
          setStatus(`完成：${detail}`);
        }
      } catch (error) {
        console.error("[OmniGPT] Export failed.", error);
        setStatus(error?.message || "导出失败", true);
      } finally {
        root.querySelectorAll(".omnigpt-action").forEach((item) => item.disabled = false);
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

  function start() {
    setupMathCopy();
    setupUi();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})(globalThis);
