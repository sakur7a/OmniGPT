// ==UserScript==
// @name         OmniGPT - ChatGPT Export & LaTeX Copy
// @name:zh-CN   OmniGPT - ChatGPT 对话导出与 LaTeX 复制
// @namespace    https://github.com/sakur7a/OmniGPT
// @version      0.3.0
// @description  Export conversations and copy LaTeX as portable plain-text Markdown. Optional quote compatibility.
// @description:zh-CN 导出对话，复制为保留 LaTeX 的纯文本 Markdown；可选引用兼容。
// @author       OmniGPT contributors
// @license      GPL-3.0-or-later
// @homepageURL  https://github.com/sakur7a/OmniGPT
// @supportURL   https://github.com/sakur7a/OmniGPT/issues
// @downloadURL  https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js
// @updateURL    https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

globalThis.OmniGPTVersion = "0.3.0";

(function initClipboard(global) {
  "use strict";
  if (global.OmniGPTClipboard) return;

  const MATH = ".katex-display, .katex, mjx-container, .MathJax, math, [data-math-source], [data-latex], [data-tex], [data-original-tex]";
  const SOURCE_ATTRS = ["data-math-source", "data-latex", "data-tex", "data-original-tex", "alttext"];
  const TEX_ANNOTATION = 'annotation[encoding="application/x-tex"], annotation[encoding="application/x-latex"]';
  const MESSAGE = '[data-message-author-role], section[data-turn], [data-testid^="conversation-turn-"], main article, main .markdown';
  const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
  const SKIP = 'button, nav, aside, footer, style, noscript, svg, mjx-assistive-mml, annotation, annotation-xml, [hidden], [aria-hidden="true"], .sr-only, #omnigpt-root';
  const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "FIGURE", "FIGCAPTION", "DL", "DT", "DD"]);
  const QUOTE_KEY = "omnigpt.quote-compat";
  const STYLE_KEY = "omnigpt.math-style";
  let mathStyle = "markdown";
  let quoteEnabled = false;
  let quotePatches = [];
  let installed = false;
  let copyFallbackActive = false;

  const elementOf = (node) => node?.nodeType === 1 ? node : node?.parentElement;
  function unwrapTex(source) {
    const value = String(source || "").trim();
    for (const [left, right] of [["$$", "$$"], ["\\[", "\\]"], ["\\(", "\\)"], ["$", "$"]]) {
      if (value.startsWith(left) && value.endsWith(right) && value.length >= left.length + right.length) {
        return value.slice(left.length, -right.length).trim();
      }
    }
    return value;
  }

  function formatFormula(formula, style = mathStyle) {
    if (style === "raw") return formula.tex;
    if (style === "latex") return formula.display ? `\\[\n${formula.tex}\n\\]` : `\\(${formula.tex}\\)`;
    return formula.display ? `$$\n${formula.tex}\n$$` : `$${formula.tex}$`;
  }

  function setMathStyle(style, persist = true) {
    if (!["markdown", "latex"].includes(style)) throw new TypeError("Unknown formula style");
    mathStyle = style;
    if (persist) try { global.localStorage.setItem(STYLE_KEY, style); } catch (_) { /* Storage is optional. */ }
  }

  // A formula is atomic; unrelated turns and ordinary editor selections remain untouched.
  function formulaRoot(node) {
    let root = null;
    let element = elementOf(node);
    if (element?.closest("pre, code, " + EDITABLE)) return null;
    for (; element; element = element.parentElement) {
      if (element.matches(MESSAGE)) break;
      if (element.matches(MATH)) root = element;
    }
    return root;
  }

  function readFormula(node) {
    let source = "";
    let carrier = node;
    for (const attr of SOURCE_ATTRS) {
      source = node.getAttribute(attr) || "";
      if (source.trim()) break;
    }
    if (!source.trim()) {
      const annotation = node.querySelector(TEX_ANNOTATION);
      source = annotation?.textContent || "";
      carrier = annotation || node;
    }
    if (!source.trim()) {
      carrier = node.querySelector("[data-math-source], [data-latex], [data-tex], [data-original-tex], math[alttext]") || node;
      for (const attr of SOURCE_ATTRS) {
        source = carrier.getAttribute(attr) || "";
        if (source.trim()) break;
      }
    }
    // Inspect only this formula's ancestor chain, not a sibling display formula or layout width.
    let display = null;
    for (let item = carrier; item && !item.matches(MESSAGE); item = item.parentElement) {
      if (item.matches('.katex-display, .MathJax_Display, .math-display, [data-math-display="true"], mjx-container[display="true"], math[display="block"]')) { display = true; break; }
      if (item.matches('[data-math-display="false"], mjx-container[display="false"], math[display="inline"]')) { display = false; break; }
    }
    // A source wrapper can own one renderer. Never search arbitrary descendants for display hints.
    const renderer = node.matches("mjx-container, .MathJax") ? node : node.querySelector("mjx-container, .MathJax");
    if (display === null && renderer?.hasAttribute("display")) display = renderer.getAttribute("display") === "true";
    if (!source.trim() && renderer) {
      try {
        const item = global.MathJax?.startup?.document?.getMathItemsWithin?.([renderer])?.[0];
        if (typeof item?.math === "string") { source = item.math; display = Boolean(item.display); }
        const legacy = global.MathJax?.Hub?.getJaxFor?.(renderer);
        if (!source && typeof legacy?.originalText === "string") source = legacy.originalText;
      } catch (_) { /* Renderer internals are optional. */ }
      const sibling = renderer.nextElementSibling;
      if (!source && sibling?.matches('script[type^="math/tex"]')) {
        source = sibling.textContent || "";
        display = /mode\s*=\s*display/i.test(sibling.type);
      }
    }
    const trimmed = source.trim();
    if ((trimmed.startsWith("$$") && trimmed.endsWith("$$")) || (trimmed.startsWith("\\[") && trimmed.endsWith("\\]"))) display = true;
    else if ((trimmed.startsWith("\\(") && trimmed.endsWith("\\)")) || (trimmed.startsWith("$") && trimmed.endsWith("$") && !trimmed.startsWith("$$"))) display = false;
    return { tex: unwrapTex(source), display: display === true };
  }

  function eligibleRange(range) {
    if (!range || range.collapsed) return false;
    const start = elementOf(range.startContainer);
    const end = elementOf(range.endContainer);
    return Boolean(start?.closest(MESSAGE) && end?.closest(MESSAGE) &&
      !start.closest(EDITABLE + ", #omnigpt-root, nav, aside") && !end.closest(EDITABLE + ", #omnigpt-root, nav, aside"));
  }

  function escapeProse(text) {
    return text.replace(/\u00a0/g, " ").replace(/\u200b/g, "").replace(/[\t\n\r ]+/g, " ")
      .replace(/([\\`*_\[\]])/g, "\\$1");
  }

  function serializeRange(range, options = {}) {
    if (!eligibleRange(range)) return null;
    const tokens = [];
    const prefix = `\uE000omnigpt-${Math.random().toString(36).slice(2)}-`;
    const protect = (value) => { tokens.push(value); return `${prefix}${tokens.length - 1}\uE001`; };
    const style = options.mathStyle || mathStyle;
    let mathCount = 0;
    let visitedNodes = 0;
    let codeDepth = 0;
    const listPositions = new WeakMap();
    const rawText = (node) => {
      const text = node.nodeValue || "";
      const end = node === range.endContainer ? range.endOffset : text.length;
      const start = node === range.startContainer ? range.startOffset : 0;
      return text.slice(start, end);
    };
    const intersects = (node) => { try { return range.intersectsNode(node); } catch (_) { return false; } };
    const clean = (text) => text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const children = (node) => {
      let first = node.firstChild;
      let lastExclusive = null;
      if (node === range.startContainer) first = node.childNodes[range.startOffset] || null;
      else if (node.contains(range.startContainer)) {
        let child = range.startContainer;
        while (child.parentNode !== node && child.parentNode) child = child.parentNode;
        if (child.parentNode === node) first = child;
      }
      if (node === range.endContainer) lastExclusive = node.childNodes[range.endOffset] || null;
      else if (node.contains(range.endContainer)) {
        let child = range.endContainer;
        while (child.parentNode !== node && child.parentNode) child = child.parentNode;
        if (child.parentNode === node) lastExclusive = child.nextSibling;
      }
      let result = "";
      for (let child = first; child && child !== lastExclusive; child = child.nextSibling) result += render(child);
      return result;
    };
    const render = (node) => {
      if (!intersects(node)) return "";
      visitedNodes += 1;
      if (node.nodeType === 3) return codeDepth ? rawText(node) : escapeProse(rawText(node));
      if (node.nodeType !== 1) return "";
      const tag = node.tagName.toUpperCase();
      if (!codeDepth && node.matches(MATH) && !node.matches(MESSAGE)) {
        const formula = readFormula(node);
        if (formula.tex) {
          mathCount += 1;
          const text = formatFormula(formula, style);
          return formula.display ? `\n\n${protect(text)}\n\n` : protect(text);
        }
      }
      if (node.matches(SKIP + ", " + EDITABLE) || tag === "SCRIPT") return "";
      if (tag === "BR") return "\n";
      if (tag === "HR") return "\n\n---\n\n";
      if (tag === "IMG") {
        const alt = (node.getAttribute("alt") || "image").replace(/[\[\]\n]/g, " ");
        const src = node.getAttribute("src") || "";
        return /^(?:https?:\/\/|\/)/i.test(src) ? `![${alt}](${src.replace(/[()\s]/g, encodeURIComponent)})` : `[image: ${alt}]`;
      }
      if (tag === "PRE" || tag === "CODE") {
        if (codeDepth) return children(node);
        codeDepth += 1;
        const content = children(node);
        codeDepth -= 1;
        const longest = Math.max(0, ...(content.match(/`+/g) || []).map((run) => run.length));
        const fence = "`".repeat(Math.max(tag === "PRE" ? 3 : 1, longest + 1));
        const language = `${node.className || ""} ${node.querySelector("code")?.className || ""}`.match(/\blanguage-([\w#+-]+)/)?.[1] || "";
        return tag === "PRE" ? `\n\n${protect(`${fence}${language}\n${content.replace(/\n$/, "")}\n${fence}`)}\n\n` : protect(`${fence}${/^`|`$|^ | $/.test(content) ? " " : ""}${content}${/^`|`$|^ | $/.test(content) ? " " : ""}${fence}`);
      }
      let value = children(node);
      if (codeDepth) return value;
      if (!value) return "";
      if (/^H[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${value.trim()}\n\n`;
      if (tag === "STRONG" || tag === "B") return `**${value}**`;
      if (tag === "EM" || tag === "I") return `*${value}*`;
      if (tag === "DEL" || tag === "S") return `~~${value}~~`;
      if (tag === "A") {
        const href = node.getAttribute("href") || "";
        return /^(?:https?:\/\/|\/|#|mailto:)/i.test(href) ? `[${value}](${href.replace(/[()\s]/g, encodeURIComponent)})` : value;
      }
      if (tag === "BLOCKQUOTE") return `\n\n${clean(value).split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
      if (tag === "LI") {
        const parent = node.parentElement;
        let marker = "- ";
        if (parent?.tagName === "OL") {
          if (!listPositions.has(parent)) {
            let number = Number(parent.getAttribute("start")) || 1;
            const positions = new WeakMap();
            for (const item of parent.children) {
              if (item.tagName !== "LI") continue;
              if (item.hasAttribute("value")) number = Number(item.getAttribute("value"));
              positions.set(item, number++);
            }
            listPositions.set(parent, positions);
          }
          marker = `${listPositions.get(parent).get(node)}. `;
        }
        return `\n${marker}${value.trim().replace(/\n/g, "\n" + " ".repeat(marker.length))}\n`;
      }
      if (tag === "UL" || tag === "OL") return `\n\n${value.trim()}\n\n`;
      if (tag === "TD" || tag === "TH") return ` ${value.trim().replace(/\|/g, "\\|")} |`;
      if (tag === "TR") return `\n|${value}\n`;
      if (tag === "TABLE") {
        const lines = value.trim().split(/\n+/);
        if (lines.length) lines.splice(1, 0, `|${" --- |".repeat(node.querySelector("tr")?.children.length || 1)}`);
        return `\n\n${lines.join("\n")}\n\n`;
      }
      return BLOCK.has(tag) ? `\n\n${value.trim()}\n\n` : value;
    };
    const root = formulaRoot(range.commonAncestorContainer) || range.commonAncestorContainer;
    let text = clean(render(root));
    const tokenPattern = new RegExp(`${prefix}(\\d+)\uE001`, "g");
    text = text.replace(tokenPattern, (_, index, offset) => {
      const before = text.slice(text.lastIndexOf("\n", offset - 1) + 1, offset);
      const indent = /^(?:[ \t]|> ?)*(?:(?:[-+*]|\d+\.) )?$/.test(before)
        ? before.replace(/(?:[-+*]|\d+\.) $/, (marker) => " ".repeat(marker.length)) : "";
      return tokens[Number(index)].replace(/\n/g, `\n${indent}`);
    });
    return { text, mathCount, visitedNodes };
  }

  // Export reuses the same renderer without mutating the user's live selection or cloning a turn.
  function serializeElement(node, options = {}) {
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    return serializeRange(range, { mathStyle: "markdown", ...options });
  }

  function selectionPayload(selection) {
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const parts = [];
    let mathCount = 0;
    let visitedNodes = 0;
    for (let i = 0; i < selection.rangeCount; i += 1) {
      const part = serializeRange(selection.getRangeAt(i));
      if (!part) return null;
      parts.push(part.text);
      mathCount += part.mathCount;
      visitedNodes += part.visitedNodes;
    }
    return { text: parts.join("\n\n"), mathCount, visitedNodes };
  }

  function handleCopy(event) {
    if (copyFallbackActive || !event.clipboardData || elementOf(event.target)?.closest(EDITABLE)) return;
    try {
      const payload = selectionPayload(global.getSelection());
      if (!payload?.mathCount || !payload.text) return;
      event.clipboardData.clearData();
      event.clipboardData.setData("text/plain", payload.text);
      event.preventDefault();
      event.stopImmediatePropagation();
    } catch (_) { /* Leave native copy available on unexpected DOM changes. */ }
  }

  async function writeText(text) {
    if (global.navigator.clipboard?.writeText) {
      try { await global.navigator.clipboard.writeText(text); return; } catch (_) { /* User-gesture fallback. */ }
    }
    const doc = global.document;
    const active = doc.activeElement;
    const selection = global.getSelection();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
    const textarea = doc.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.cssText = "position:fixed;left:-9999px;top:0";
    const onCopy = (event) => {
      if (!event.clipboardData) return;
      event.clipboardData.clearData();
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    try {
      copyFallbackActive = true;
      doc.body.appendChild(textarea);
      textarea.select();
      global.addEventListener("copy", onCopy, true);
      if (!doc.execCommand("copy")) throw new Error("Clipboard write was denied.");
    } finally {
      global.removeEventListener("copy", onCopy, true);
      textarea.remove();
      active?.focus?.({ preventScroll: true });
      if (selection) { selection.removeAllRanges(); ranges.forEach((range) => selection.addRange(range)); }
      copyFallbackActive = false;
    }
  }

  function setQuoteCompatibility(enabled, persist = true) {
    if (Boolean(enabled) === quoteEnabled) return;
    if (enabled) {
      for (const [prototype, isSelection] of [[global.Range?.prototype, false], [global.Selection?.prototype, true]]) {
        if (!prototype) continue;
        const native = prototype.toString;
        const wrapper = isSelection ? function omniGPTSelectionToString() {
          const value = selectionPayload(this);
          return value?.mathCount ? value.text : native.call(this);
        } : function omniGPTRangeToString() {
          const value = serializeRange(this);
          return value?.mathCount ? value.text : native.call(this);
        };
        const safeWrapper = function () {
          try { return wrapper.call(this); } catch (_) { return native.call(this); }
        };
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "toString");
        try { prototype.toString = safeWrapper; quotePatches.push({ prototype, descriptor, wrapper: safeWrapper }); }
        catch (_) { /* Some managers lock prototypes. */ }
      }
      quoteEnabled = quotePatches.length > 0;
    } else {
      for (const patch of quotePatches) if (patch.prototype.toString === patch.wrapper) {
        if (patch.descriptor) Object.defineProperty(patch.prototype, "toString", patch.descriptor);
        else delete patch.prototype.toString;
      }
      quotePatches = [];
      quoteEnabled = false;
    }
    if (persist) try { global.localStorage.setItem(QUOTE_KEY, String(quoteEnabled)); } catch (_) { /* Private browsing. */ }
  }

  function install(onCopied = () => {}) {
    if (installed) return;
    installed = true;
    global.addEventListener("copy", handleCopy, true);
    global.addEventListener("dblclick", (event) => {
      const target = elementOf(event.target);
      if (!target?.closest(MESSAGE) || target.closest(EDITABLE)) return;
      const root = formulaRoot(target);
      if (!root) return;
      const formula = readFormula(root);
      if (!formula.tex) return;
      event.preventDefault();
      writeText(formatFormula(formula, event.altKey ? "raw" : mathStyle))
        .then(() => onCopied(event.altKey ? "TeX 源码已复制（不含定界符）" : "LaTeX 公式已复制"))
        .catch(() => onCopied("复制失败，请检查剪贴板权限"));
    });
    try {
      if (global.localStorage.getItem(STYLE_KEY) === "latex") setMathStyle("latex", false);
      if (global.localStorage.getItem(QUOTE_KEY) === "true") setQuoteCompatibility(true, false);
    } catch (_) { /* Storage optional. */ }
  }

  global.OmniGPTClipboard = Object.freeze({ install, handleCopy, selectionPayload, serializeRange, serializeElement,
    readFormula, unwrapTex, formatFormula, writeText, setMathStyle, get mathStyle() { return mathStyle; },
    setQuoteCompatibility, get quoteCompatibility() { return quoteEnabled; } });
})(globalThis);

(function initExporter(global) {
  "use strict";
  const API_PAGE_SIZE = 100;
  const DETAIL_FETCH_CONCURRENCY = 2;
  const SESSION_TTL_MS = 4 * 60 * 1000;
  const GPT_UPLOAD_TARGET_CHARS = 900000;
  const TURN = "section[data-turn='user'], section[data-turn='assistant'], [data-testid^='conversation-turn-'], [data-message-author-role]";
  const EXCLUDE = '#omnigpt-root, nav, aside, form, [hidden], [aria-hidden="true"]';
  const DOM_WARNING = "仅导出当前页面已加载的消息，屏幕外或未加载的历史可能缺失。";
  const ASSET_WARNING = "附件、图片等仅保留可用的引用或占位信息，不包含二进制文件。";
  let cachedSession = null;
  let cachedSessionAt = 0;
  let sessionPending = null;
  let cachedApiScope = null;

  const abortError = () => Object.assign(new Error("已取消导出"), { name: "AbortError" });
  function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
  function progress(options, value) { options.onProgress?.(value); }
  function getBaseOrigin() {
    return global.location?.origin === "https://chat.openai.com" ? "https://chat.openai.com" : "https://chatgpt.com";
  }
  function getConversationTitle(doc) { return (doc?.title || "ChatGPT").replace(/\s*-\s*ChatGPT\s*$/i, "").trim() || "ChatGPT"; }
  function getConversationIdFromLocation(locationLike = global.location) {
    try {
      const pathname = locationLike?.pathname || new URL(locationLike?.href || "", getBaseOrigin()).pathname;
      if (pathname.startsWith("/share/")) return "";
      return decodeURIComponent(pathname.match(/(?:^|\/)c\/([^/]+)\/?$/)?.[1] || "");
    } catch (_) { return ""; }
  }
  function slugifyTitle(title) {
    return String(title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "chatgpt-conversation";
  }
  function timestampForFile(time) { return String(time || new Date().toISOString()).replace(/:/g, "-").replace(/\.\d+Z$/, "Z"); }
  function safeLine(text) { return String(text || "").replace(/[\r\n]+/g, " "); }
  function safeTitle(text) { return safeLine(text).replace(/([\\`*_\[\]<>])/g, "\\$1"); }
  function errorWith(message, code, status) { return Object.assign(new Error(message), { code, status }); }

  async function pause(ms, signal) {
    checkAbort(signal);
    await new Promise((resolve, reject) => {
      const cancel = () => { global.clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(abortError()); };
      const timer = global.setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, ms);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  // The timer covers the response body too. Error messages never include tokens or response bodies.
  async function requestJson(pathname, headers, options = {}) {
    if (!/^\/(?:backend-api\/|api\/auth\/session$)/.test(pathname)) throw new TypeError("Unsupported request path");
    checkAbort(options.signal);
    const controller = global.AbortController ? new global.AbortController() : null;
    let timedOut = false;
    const cancel = () => controller?.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    const timer = controller ? global.setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs || 20000) : null;
    try {
      const response = await global.fetch(`${getBaseOrigin()}${pathname}`, {
        credentials: "include", cache: "no-store", redirect: "error", headers,
        ...(controller ? { signal: controller.signal } : {})
      });
      checkAbort(options.signal);
      if (!response.ok) {
        const messages = { 401: "登录已失效，请刷新后重试", 403: "没有访问权限或请求被拦截", 404: "接口或对话不可用", 429: "请求过于频繁，请稍后重试" };
        const error = errorWith(`${messages[response.status] || "请求失败"}（HTTP ${response.status}）`, "HTTP", response.status);
        const retry = response.headers?.get?.("retry-after");
        error.retryAfterMs = retry == null ? null : /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now());
        // Discard the unread body without logging private response content.
        try { await response.body?.cancel?.(); } catch (_) { /* Optional stream cleanup. */ }
        throw error;
      }
      try {
        const result = await response.json();
        checkAbort(options.signal);
        return result;
      } catch (error) {
        if (options.signal?.aborted || timedOut) throw error;
        throw errorWith("接口未返回有效 JSON，可能需要重新登录", "SCHEMA");
      }
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      if (timedOut) throw errorWith("读取超时，请重试或选择已加载页面导出", "TIMEOUT");
      if (error.code) throw error;
      throw errorWith("网络请求失败，请检查连接后重试", "NETWORK");
    } finally {
      if (timer !== null) global.clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
  }

  async function getSession(forceRefresh = false, options = {}) {
    checkAbort(options.signal);
    if (sessionPending) return sessionPending;
    if (!forceRefresh && cachedSession && Date.now() - cachedSessionAt < SESSION_TTL_MS) return cachedSession;
    sessionPending = (async () => {
      const session = await requestJson("/api/auth/session", { accept: "application/json" }, options);
      if (!session || typeof session !== "object") throw errorWith("登录会话格式不可用", "SCHEMA");
      cachedSession = session;
      cachedSessionAt = Date.now();
      if (forceRefresh) cachedApiScope = null;
      return session;
    })();
    try { return await sessionPending; } finally { sessionPending = null; }
  }
  async function getAccessToken(forceRefresh, options) {
    try {
      const session = await getSession(forceRefresh, options);
      return session.accessToken || session.access_token || null;
    } catch (error) {
      if (error.name === "AbortError" || error.status === 429) throw error;
      return null; // A bounded cookie-auth attempt remains available.
    }
  }
  function buildHeaders(token, scope) {
    return { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(scope?.accountId ? { [scope.headerName]: scope.accountId } : {}) };
  }
  function accountCandidates() {
    // Only explicit account identifiers; do not scan or deserialize the entire site's storage.
    return [...new Set([cachedSession?.account?.id, cachedSession?.account_id, cachedSession?.current_account_id])]
      .filter((id) => typeof id === "string" && /^[\w-]{6,160}$/.test(id)).slice(0, 2);
  }
  async function fetchJson(pathname, options = {}) {
    const { requireAuth = false, retryWithFreshToken = true } = options;
    let token = requireAuth ? await getAccessToken(false, options) : null;
    let refreshed = false;
    let transientRetries = 0;
    let scope = cachedApiScope;
    let scopes = null;
    while (true) {
      checkAbort(options.signal);
      try {
        const result = await requestJson(pathname, buildHeaders(token, scope), options);
        if (scope) cachedApiScope = scope;
        return result;
      } catch (error) {
        if (error.name === "AbortError") throw error;
        if (requireAuth && retryWithFreshToken && !refreshed && [401, 403, 404].includes(error.status)) {
          refreshed = true;
          const current = cachedSession?.accessToken || cachedSession?.access_token;
          token = current && current !== token ? current : await getAccessToken(true, options);
          scope = cachedApiScope;
          continue;
        }
        if ([429, 500, 502, 503, 504].includes(error.status) && transientRetries < 2) {
          const delay = error.retryAfterMs ?? 750 * 2 ** transientRetries;
          if (!Number.isFinite(delay) || delay > 30000) throw error;
          transientRetries += 1;
          progress(options, { phase: "retry", status: error.status, attempt: transientRetries });
          await pause(delay, options.signal);
          continue;
        }
        if (requireAuth && error.status === 404 && pathname.startsWith("/backend-api/")) {
          scopes ??= accountCandidates().flatMap((accountId) => ["chatgpt-account-id", "openai-account-id"].map((headerName) => ({ accountId, headerName })))
            .filter((candidate) => candidate.accountId !== scope?.accountId || candidate.headerName !== scope?.headerName);
          if (scopes.length) { scope = scopes.shift(); continue; }
        }
        throw error;
      }
    }
  }

  async function fetchConversationDetail(id, options = {}) {
    if (!id) throw errorWith("缺少对话 ID", "SCHEMA");
    for (const [index, prefix] of ["conversation", "conversations"].entries()) {
      try {
        const result = await fetchJson(`/backend-api/${prefix}/${encodeURIComponent(id)}`, { ...options, requireAuth: true });
        return result?.conversation?.mapping ? result.conversation : result;
      } catch (error) { if (index || ![404, 405].includes(error.status)) throw error; }
    }
  }

  function activeNodes(conversation) {
    const mapping = conversation?.mapping;
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) throw errorWith("对话结构不可识别", "SCHEMA");
    let nodeId = conversation.current_node;
    const warnings = [];
    if (!nodeId || !Object.hasOwn(mapping, nodeId)) {
      const parents = new Set(Object.values(mapping).map((node) => node?.parent).filter(Boolean));
      const leaves = Object.keys(mapping).filter((id) => !parents.has(id));
      if (leaves.length !== 1) throw errorWith("无法确定当前回答分支，未混合导出备选回答", "BRANCH");
      nodeId = leaves[0];
      warnings.push("接口未标记当前分支，使用唯一叶节点对应的分支。");
    }
    const nodes = [];
    const visited = new Set();
    while (nodeId) {
      if (!Object.hasOwn(mapping, nodeId) || !mapping[nodeId] || visited.has(nodeId)) throw errorWith("对话分支存在缺失节点或循环", "BRANCH");
      visited.add(nodeId);
      nodes.push({ ...mapping[nodeId], id: nodeId });
      nodeId = mapping[nodeId].parent;
    }
    return { nodes: nodes.reverse(), warnings };
  }
  function partText(part, state) {
    if (typeof part === "string") return part;
    if (part == null) return "";
    if (Array.isArray(part)) return part.map((item) => partText(item, state)).join("\n\n");
    if (typeof part === "object") {
      if (typeof part.text === "string") return part.text;
      if (part.parts) return partText(part.parts, state);
      if (part.content) return partText(part.content, state);
      state.assets = true;
      return `[附件/非文本内容：${safeLine(part.name || part.content_type || "asset")}]`;
    }
    return String(part);
  }
  function messagesFromNodes(nodes) {
    const state = { assets: false };
    const messages = [];
    for (const node of nodes) {
      const message = node.message;
      const role = message?.author?.role;
      if (!["user", "assistant"].includes(role) || message?.metadata?.is_visually_hidden_from_conversation ||
          ["analysis", "justify", "confidence"].includes(message?.channel) ||
          (role === "assistant" && message.recipient && message.recipient !== "all")) continue;
      if (message?.metadata?.attachments?.length) state.assets = true;
      const content = message.text ?? message.content?.parts ?? message.content?.text ?? message.parts;
      const text = content == null && message.content?.content_type ? partText(message.content, state) : partText(content, state);
      if (!text.trim()) continue;
      messages.push({ index: messages.length + 1, id: message.id || node.id, role, text, markdown: text,
        ...(message.create_time != null ? { createTime: message.create_time } : {}) });
    }
    return { messages, warnings: state.assets ? [ASSET_WARNING] : [] };
  }
  function extractMessagesFromApiConversation(conversation) { return messagesFromNodes(activeNodes(conversation).nodes).messages; }
  function conversationFromApi(detail, summary = {}) {
    const path = activeNodes(detail);
    const result = messagesFromNodes(path.nodes);
    if (!result.messages.length) throw errorWith("未找到可导出的用户或助手正文", "EMPTY");
    const id = detail.id || detail.conversation_id || summary.id || summary.conversation_id || "";
    return { schemaVersion: 1, id, title: detail.title || summary.title || "Untitled conversation",
      url: id ? `${getBaseOrigin()}/c/${encodeURIComponent(id)}` : "", exportedAt: new Date().toISOString(),
      createTime: detail.create_time ?? summary.create_time ?? null, updateTime: detail.update_time ?? summary.update_time ?? null,
      acquisition: "api", partial: false, warnings: [...path.warnings, ...result.warnings],
      messageCount: result.messages.length, messages: result.messages };
  }

  function collectConversation(doc = global.document) {
    if (!global.OmniGPTClipboard?.serializeElement) throw errorWith("页面解析模块不可用，请刷新页面", "DOM");
    const root = doc.querySelector("main") || doc;
    const canonical = (node) => node.closest("section[data-turn], [data-testid^='conversation-turn-']") || node;
    // querySelectorAll on one union preserves DOM order (not all users followed by assistants).
    const nodes = [...new Set(Array.from(root.querySelectorAll(TURN), canonical))];
    const selected = new Set(nodes);
    const messages = [];
    for (const node of nodes) {
      if (node.closest(EXCLUDE)) continue;
      let nested = false;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) if (selected.has(parent)) { nested = true; break; }
      if (nested) continue;
      if (global.getComputedStyle) {
        const style = global.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") continue;
      }
      const role = node.getAttribute("data-turn") || node.getAttribute("data-message-author-role") || node.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role") || "assistant";
      if (!["user", "assistant"].includes(role)) continue;
      const rendered = global.OmniGPTClipboard.serializeElement(node, { mathStyle: "markdown" });
      if (!rendered?.text?.trim()) continue;
      messages.push({ index: messages.length + 1, role, text: rendered.text, markdown: rendered.text });
    }
    return { schemaVersion: 1, title: getConversationTitle(doc), url: global.location?.href || "", exportedAt: new Date().toISOString(),
      acquisition: "dom", partial: true, warnings: [DOM_WARNING, ASSET_WARNING], messageCount: messages.length, messages };
  }

  async function collectCurrentConversation(doc = global.document, options = {}) {
    const locationAtStart = global.location?.href;
    const ensureLocation = () => {
      checkAbort(options.signal);
      if (global.location?.href !== locationAtStart) throw errorWith("页面已切换，请在目标对话重新导出", "NAVIGATION");
    };
    const id = getConversationIdFromLocation();
    let apiError = null;
    if (id && options.source !== "dom") {
      progress(options, { phase: "current", source: "api" });
      try {
        const result = conversationFromApi(await fetchConversationDetail(id, options), { id, title: getConversationTitle(doc) });
        ensureLocation();
        return result;
      } catch (error) {
        ensureLocation();
        if (error.name === "AbortError") throw error;
        apiError = error;
      }
    }
    ensureLocation();
    progress(options, { phase: "current", source: "dom" });
    const result = collectConversation(doc);
    if (apiError) result.warnings.unshift(`完整对话读取失败：${apiError.message}；已回退为页面导出。`);
    if (!result.messageCount) throw apiError || errorWith("页面未找到可导出的正文", "EMPTY");
    return result;
  }

  async function fetchAllConversationSummaries(options = {}) {
    const max = Number(options.maxConversations || 0);
    if (!Number.isInteger(max) || max < 0) throw new TypeError("Invalid conversation limit");
    const conversations = [];
    const seen = new Set();
    let offset = 0;
    for (let page = 0; page < 200; page += 1) {
      checkAbort(options.signal);
      const payload = await fetchJson(`/backend-api/conversations?offset=${offset}&limit=${API_PAGE_SIZE}&order=updated`, { ...options, requireAuth: true });
      const items = Array.isArray(payload) ? payload : [payload?.items, payload?.conversations, payload?.data].find(Array.isArray);
      if (!items) throw errorWith("历史列表格式变化，未返回空归档", "SCHEMA");
      if (!items.length) {
        if (payload.has_more === true) throw errorWith("历史分页返回空页但仍有下一页，已停止避免漏导", "PAGINATION");
        return conversations;
      }
      let added = 0;
      for (const item of items) {
        const id = item?.id || item?.conversation_id;
        if (!id) throw errorWith("历史条目缺少 ID", "SCHEMA");
        if (seen.has(id)) continue;
        seen.add(id); added += 1;
        conversations.push({ ...item, id });
        if (max && conversations.length >= max) return conversations;
      }
      progress(options, { phase: "listing", completed: conversations.length });
      if (!added) throw errorWith("历史分页重复，已停止避免无限请求", "PAGINATION");
      offset += items.length;
      if (payload.has_more === false || (typeof payload.total === "number" && offset >= payload.total) ||
          (payload.has_more !== true && typeof payload.total !== "number" && items.length < API_PAGE_SIZE)) return conversations;
    }
    throw errorWith("历史分页超过安全上限，请限制导出数量", "PAGINATION");
  }
  async function collectAllConversations(options = {}) {
    const summaries = await fetchAllConversationSummaries(options);
    if (!summaries.length) throw errorWith("当前账号历史列表没有可导出的对话", "EMPTY");
    const conversations = [];
    const failures = [];
    for (let i = 0; i < summaries.length; i += DETAIL_FETCH_CONCURRENCY) {
      checkAbort(options.signal);
      let fatal = null;
      const batch = await Promise.all(summaries.slice(i, i + DETAIL_FETCH_CONCURRENCY).map(async (summary) => {
        try { return conversationFromApi(await fetchConversationDetail(summary.id, options), summary); }
        catch (error) {
          if (error.name === "AbortError" || [401, 403, 429].includes(error.status)) fatal = error;
          failures.push({ id: summary.id, title: summary.title || "Untitled", error: error.message, code: error.code, status: error.status });
          return null;
        }
      }));
      if (fatal) throw fatal;
      conversations.push(...batch.filter(Boolean));
      progress(options, { phase: "details", completed: Math.min(i + DETAIL_FETCH_CONCURRENCY, summaries.length),
        total: summaries.length, succeeded: conversations.length, failed: failures.length });
      // Yield between batches; no idle polling or permanently running timer.
      await pause(0, options.signal);
    }
    checkAbort(options.signal);
    if (!conversations.length) throw errorWith(`全部 ${failures.length} 条对话读取失败，未生成空归档。${failures[0]?.error || ""}`, "EMPTY");
    return { schemaVersion: 1, exportedAt: new Date().toISOString(), source: getBaseOrigin(), scope: "accessible-history-list",
      totalConversations: conversations.length, requestedConversations: summaries.length, failedConversations: failures.length,
      partial: failures.length > 0, warnings: ["仅涵盖当前账号历史列表返回的对话，不保证包含其他工作区、已归档或项目内未列出的对话。", ASSET_WARNING],
      failures, conversations };
  }

  function formatRoleLabel(role) { return ({ user: "User", assistant: "ChatGPT", system: "System", tool: "Tool" })[role] || String(role); }
  function warningLines(value) { return (value.warnings || []).map((warning) => `> 注意：${safeLine(warning)}`).join("\n"); }
  function formatMarkdown(conversation, options = {}) {
    const sections = [`# ${safeTitle(conversation.title)}`];
    if (options.includeMetadata !== false) sections.push(`- Exported at: ${conversation.exportedAt || ""}\n- Source: ${conversation.url || ""}\n- Messages: ${conversation.messageCount}\n- Acquisition: ${conversation.acquisition || "unknown"}`);
    if (conversation.warnings?.length) sections.push(warningLines(conversation));
    for (const message of conversation.messages) sections.push(`## ${message.index}. ${formatRoleLabel(message.role)}\n\n${message.markdown ?? message.text ?? ""}`);
    // Do not normalize the assembled document: that would destroy code indentation and blank lines.
    return sections.join("\n\n") + "\n";
  }
  function formatText(conversation, options = {}) {
    const sections = [safeLine(conversation.title)];
    if (options.includeMetadata !== false) sections.push(`Exported at: ${conversation.exportedAt || ""}\nSource: ${conversation.url || ""}\nMessages: ${conversation.messageCount}`);
    if (conversation.warnings?.length) sections.push(conversation.warnings.join("\n"));
    for (const message of conversation.messages) sections.push(`[${message.index}] ${formatRoleLabel(message.role)}\n${message.text ?? message.markdown ?? ""}`);
    return sections.join("\n\n") + "\n";
  }
  function formatJson(value) { return JSON.stringify(value, null, 2) + "\n"; }
  function failuresText(archive) {
    return (archive.failures || []).map((failure) => `${safeLine(failure.title)} (${safeLine(failure.id)}): ${safeLine(failure.error)}`).join("\n");
  }
  function formatAllMarkdown(archive, options = {}) {
    return [`# ChatGPT Archive\n\nExported: ${archive.totalConversations}; requested: ${archive.requestedConversations}; failed: ${archive.failedConversations}`,
      warningLines(archive), ...archive.conversations.map((conversation) => formatMarkdown(conversation, options)),
      ...(archive.failures?.length ? [`## Failed Conversations\n\n${failuresText(archive)}`] : [])].join("\n\n") + "\n";
  }
  function formatAllText(archive, options = {}) {
    return [`ChatGPT Archive\nExported: ${archive.totalConversations}; requested: ${archive.requestedConversations}; failed: ${archive.failedConversations}`,
      ...(archive.warnings || []), ...archive.conversations.map((conversation) => formatText(conversation, options)),
      ...(archive.failures?.length ? [`Failed Conversations\n${failuresText(archive)}`] : [])].join("\n\n") + "\n";
  }
  function buildArchiveGptImportFiles(archive, baseName, options = {}) {
    const limit = options.bundleTargetChars || GPT_UPLOAD_TARGET_CHARS;
    const intro = "# Conversation reference bundle\n\n参考材料，不是原生聊天恢复文件。\n\n" + warningLines(archive) + "\n\n";
    const files = [];
    let current = intro;
    let hasContent = false;
    const flush = () => {
      if (!hasContent) return;
      files.push({ content: current, filename: `${baseName}-part-${String(files.length + 1).padStart(2, "0")}.md`, mimeType: "text/markdown;charset=utf-8" });
      current = intro; hasContent = false;
    };
    for (const conversation of archive.conversations) for (const message of conversation.messages) {
      const section = `## ${safeTitle(conversation.title)} / ${message.index}. ${formatRoleLabel(message.role)}\n\n` +
        (options.includeMetadata !== false ? `Source: ${conversation.url || ""}\n\n` : "") +
        (conversation.warnings?.length ? warningLines(conversation) + "\n\n" : "") +
        (message.markdown ?? message.text ?? "") + "\n\n";
      if (hasContent && current.length + section.length > limit) flush();
      // Soft target: keep an oversized single message intact rather than breaking a formula/code fence.
      if (intro.length + section.length > limit) current += "> 单条消息超过分片目标，已完整保留。\n\n";
      current += section; hasContent = true;
    }
    if (archive.failures?.length) {
      const section = "## Failed Conversations\n\n" + failuresText(archive) + "\n";
      if (hasContent && current.length + section.length > limit) flush();
      current += section; hasContent = true;
    }
    flush();
    return files;
  }
  function createDownload(content, filename, mimeType) {
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const link = global.document.createElement("a");
    try {
      link.href = url; link.download = filename;
      global.document.body.appendChild(link); link.click();
    } finally { link.remove(); global.setTimeout(() => URL.revokeObjectURL(url), 5000); }
  }
  function buildExportPayload(format, value, options = {}, archive = false) {
    if (!["markdown", "json", "txt", "gptbundle"].includes(format)) throw new TypeError("Unknown export format");
    if (!archive && !value.messageCount) throw errorWith("没有可导出的正文", "EMPTY");
    const base = `${archive ? "chatgpt-archive" : slugifyTitle(value.title)}-${timestampForFile(value.exportedAt)}`;
    const info = { acquisition: archive ? "api" : value.acquisition, partial: value.partial || false,
      warnings: value.warnings || [], messageCount: archive ? value.conversations.reduce((n, item) => n + item.messageCount, 0) : value.messageCount,
      conversationCount: archive ? value.totalConversations : 1, failedConversations: value.failedConversations || 0 };
    if (format === "gptbundle") {
      const bundle = archive ? value : { ...value, conversations: [value], failures: [] };
      const files = buildArchiveGptImportFiles(bundle, base, options);
      return files.length === 1 ? { ...files[0], info } : { files, info };
    }
    const content = format === "json" ? formatJson(value) : format === "txt" ? (archive ? formatAllText : formatText)(value, options) : (archive ? formatAllMarkdown : formatMarkdown)(value, options);
    return { content, filename: `${base}.${format === "markdown" ? "md" : format}`, mimeType: format === "json" ? "application/json;charset=utf-8" : `text/${format === "txt" ? "plain" : "markdown"};charset=utf-8`, info };
  }
  function getExportPayload(format, doc, options = {}) { return buildExportPayload(format, collectConversation(doc), options); }
  async function getCurrentExportPayload(format, doc, options = {}) { return buildExportPayload(format, await collectCurrentConversation(doc, options), options); }
  async function getArchiveExportPayload(format, options = {}) { return buildExportPayload(format, await collectAllConversations(options), options, true); }
  global.ChatGPTExporter = { collectConversation, collectCurrentConversation, collectAllConversations, createDownload,
    extractMessagesFromApiConversation, fetchConversationDetail, fetchAllConversationSummaries, fetchJson,
    formatAllMarkdown, formatAllText, formatJson, formatMarkdown, formatText, buildArchiveGptImportFiles, buildExportPayload,
    getArchiveExportPayload, getConversationIdFromLocation, getConversationTitle, getCurrentExportPayload, getExportPayload, slugifyTitle };
})(globalThis);

(function initOmniGPT(global) {
  "use strict";
  if (global.__omniGPTInjected || !global.OmniGPTClipboard) return;
  global.__omniGPTInjected = true;
  const ROOT_ID = "omnigpt-root";
  const clipboard = global.OmniGPTClipboard;
  const exporter = global.ChatGPTExporter;
  const SETTINGS_KEY = "omnigpt.export-options";
  let root, launcher, panel, controls, task;
  let lastProgressAt = 0;
  let preferences = { format: "markdown", includeMetadata: true };
  try {
    const saved = JSON.parse(global.localStorage.getItem(SETTINGS_KEY) || "{}");
    if (["markdown", "json", "txt", "gptbundle"].includes(saved.format)) preferences.format = saved.format;
    if (typeof saved.includeMetadata === "boolean") preferences.includeMetadata = saved.includeMetadata;
  } catch (_) { /* Storage is optional. */ }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function button(text, action) {
    const node = element("button", "omnigpt-action", text);
    node.type = "button"; node.dataset.action = action;
    return node;
  }
  function selectField(text, key, values) {
    const label = element("label", "omnigpt-field");
    const select = element("select"); select.dataset.field = key;
    for (const [value, title] of values) {
      const option = element("option", "", title); option.value = value; select.append(option);
    }
    label.append(element("span", "", text), select);
    return { label, select };
  }
  function checkbox(text, key, checked) {
    const label = element("label", "omnigpt-check");
    const input = element("input"); input.type = "checkbox"; input.dataset.field = key; input.checked = checked;
    label.append(input, document.createTextNode(text));
    return { label, input };
  }
  function showToast(message) {
    if (!document.body) return;
    document.getElementById("omnigpt-toast")?.remove();
    const toast = element("div", "", message); toast.id = "omnigpt-toast";
    toast.setAttribute("role", "status"); document.body.append(toast);
    global.setTimeout(() => toast.remove(), 1400);
  }
  // Register before ordinary page handlers; no observer, polling, or initial formula scan.
  clipboard.install(showToast);

  function injectStyles() {
    if (document.getElementById("omnigpt-style")) return;
    const style = element("style"); style.id = "omnigpt-style";
    style.textContent = `
#omnigpt-root{--og-bg:#fff;--og-fg:#202124;--og-muted:#60656d;--og-border:#d6d8dc;--og-control:#f6f7f8;color-scheme:light;position:fixed;right:18px;bottom:18px;z-index:2147483000;color:var(--og-fg);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
#omnigpt-root *{box-sizing:border-box}#omnigpt-root [hidden]{display:none!important}
#omnigpt-root button,#omnigpt-root select{font:inherit;color:inherit;border:1px solid var(--og-border);background:var(--og-control);border-radius:8px}
#omnigpt-root button{cursor:pointer;padding:8px 12px}#omnigpt-root button:disabled,#omnigpt-root select:disabled{opacity:.55;cursor:default}
#omnigpt-root :focus-visible{outline:2px solid var(--og-fg);outline-offset:2px}
#omnigpt-root .omnigpt-launcher{border-radius:99px;background:var(--og-bg);box-shadow:0 2px 9px #0002;font-weight:650}
#omnigpt-root .omnigpt-mark{display:none}
#omnigpt-root .omnigpt-panel{position:absolute;right:0;bottom:50px;width:min(340px,calc(100vw - 24px));max-height:calc(100dvh - 30px);overflow:auto;padding:16px;border:1px solid var(--og-border);border-radius:12px;background:var(--og-bg);box-shadow:0 6px 22px #0002}
#omnigpt-root .omnigpt-header,#omnigpt-root .omnigpt-actions{display:flex;align-items:center;gap:8px}
#omnigpt-root .omnigpt-header{justify-content:space-between;margin-bottom:12px}#omnigpt-root .omnigpt-title{font-size:16px;font-weight:700}
#omnigpt-root .omnigpt-version{font-size:11px;color:var(--og-muted);margin-left:8px}#omnigpt-root [data-action=close]{border:0;background:none;padding:2px 6px;font-size:20px}
#omnigpt-root .omnigpt-field{display:grid;grid-template-columns:74px minmax(0,1fr);align-items:center;gap:8px;margin:10px 0}
#omnigpt-root select{width:100%;min-width:0;padding:7px 6px}#omnigpt-root .omnigpt-check{display:flex;gap:8px;align-items:flex-start;margin:12px 0}#omnigpt-root input{accent-color:var(--og-fg);margin-top:4px}
#omnigpt-root .omnigpt-hint{color:var(--og-muted);font-size:12px;margin:8px 0;line-height:1.6}
#omnigpt-root details{border-top:1px solid var(--og-border);margin-top:12px;padding-top:10px}#omnigpt-root summary{cursor:pointer;color:var(--og-muted)}
#omnigpt-root .omnigpt-actions{margin-top:14px;flex-wrap:wrap}#omnigpt-root [data-action=export]{background:var(--og-fg);color:var(--og-bg);border-color:var(--og-fg)}
#omnigpt-root .omnigpt-status{font-size:12px;white-space:pre-line;overflow-wrap:anywhere;margin-top:10px}#omnigpt-root .omnigpt-status[data-kind=error]{color:#b3261e}#omnigpt-root .omnigpt-status[data-kind=warning]{color:#865300}
#omnigpt-root progress{width:100%;height:6px;margin-top:14px;accent-color:var(--og-fg)}
#omnigpt-root .omnigpt-files{max-height:180px;overflow:auto;display:grid;gap:6px;margin-top:10px}#omnigpt-root .omnigpt-files button{text-align:left;overflow-wrap:anywhere;font-size:12px}
#omnigpt-toast{position:fixed;left:50%;bottom:10%;max-width:90vw;transform:translateX(-50%);z-index:2147483647;padding:9px 15px;border-radius:9px;background:#202124;color:#fff;font:12px/1.5 system-ui}
@media(prefers-color-scheme:dark){#omnigpt-root{--og-bg:#1b1c1e;--og-fg:#eceef1;--og-muted:#b2b7bf;--og-border:#45484d;--og-control:#27292c;color-scheme:dark}#omnigpt-root .omnigpt-status[data-kind=error]{color:#ffb4ab}#omnigpt-root .omnigpt-status[data-kind=warning]{color:#e9c46a}}
html.dark #omnigpt-root{--og-bg:#1b1c1e;--og-fg:#eceef1;--og-muted:#b2b7bf;--og-border:#45484d;--og-control:#27292c;color-scheme:dark}
html.light #omnigpt-root{--og-bg:#fff;--og-fg:#202124;--og-muted:#60656d;--og-border:#d6d8dc;--og-control:#f6f7f8;color-scheme:light}
@media (max-width:1100px){#omnigpt-root{right:10px;top:50%;bottom:auto;transform:translateY(-50%)}#omnigpt-root .omnigpt-launcher{width:36px;height:36px;padding:0}#omnigpt-root .omnigpt-mark{display:block}#omnigpt-root .omnigpt-label{display:none}#omnigpt-root .omnigpt-panel{right:46px;top:50%;bottom:auto;transform:translateY(-50%);width:min(340px,calc(100vw - 70px));max-height:calc(100dvh - 24px)}}
`;
    document.head.append(style);
  }
  function setStatus(text, kind = "info") {
    if (!controls) return;
    controls.status.textContent = text; controls.status.dataset.kind = kind;
  }
  function renderProgress(value) {
    const now = Date.now();
    if (value.completed !== value.total && now - lastProgressAt < 100) return;
    lastProgressAt = now;
    if (value.total) { controls.progress.max = value.total; controls.progress.value = value.completed; }
    else controls.progress.removeAttribute("value");
    if (value.phase === "listing") setStatus(`读取历史列表：${value.completed} 条`);
    if (value.phase === "details") setStatus(`读取对话 ${value.completed}/${value.total}；成功 ${value.succeeded}，失败 ${value.failed}`);
    if (value.phase === "current") setStatus(value.source === "api" ? "读取完整对话…" : "读取已加载页面…");
    if (value.phase === "retry") setStatus(`HTTP ${value.status}，有限重试 ${value.attempt}/2…`);
  }
  function syncControls() {
    const all = controls.scope.value === "all";
    controls.limitLabel.hidden = !all;
    controls.sourceLabel.hidden = all;
    controls.copy.disabled = Boolean(task) || all;
    controls.cancel.hidden = !task;
    for (const input of panel.querySelectorAll("select, input")) input.disabled = Boolean(task);
    controls.export.disabled = Boolean(task);
    controls.hint.textContent = all ? "读取当前账号历史列表；附件仅保留引用。大量历史可在更多选项中限制数量。" :
      ({ markdown: "适合笔记和知识库；保留公式、代码和正文。", json: "结构化正文与来源信息；不是原始账号备份。", txt: "UTF-8 文本；保留 API 正文，可能仍含 Markdown 标记。", gptbundle: "按消息分片为 Markdown；单条超长消息不强行切断。" })[controls.format.value];
  }
  function buildPanel() {
    panel = element("section", "omnigpt-panel"); panel.id = "omnigpt-panel";
    panel.hidden = true; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-labelledby", "omnigpt-title");
    const header = element("div", "omnigpt-header");
    const title = element("div", "omnigpt-title", "OmniGPT"); title.id = "omnigpt-title";
    title.append(element("span", "omnigpt-version", global.OmniGPTVersion || "0.3.0"));
    const close = button("×", "close"); close.setAttribute("aria-label", "关闭面板");
    header.append(title, close);
    const scope = selectField("导出范围", "scope", [["current", "当前对话"], ["all", "历史对话"]]);
    const format = selectField("文件格式", "format", [["markdown", "Markdown (.md)"], ["json", "JSON (.json)"], ["txt", "文本 (.txt)"], ["gptbundle", "参考材料分片 (.md)"]]);
    format.select.value = preferences.format;
    const hint = element("p", "omnigpt-hint");
    const details = element("details"); details.append(element("summary", "", "更多选项"));
    const source = selectField("读取方式", "source", [["auto", "完整对话优先"], ["dom", "仅已加载页面（离线）"]]);
    const limit = selectField("历史数量", "limit", [["0", "列表返回的全部"], ["50", "最近 50 条"], ["200", "最近 200 条"]]);
    const metadata = checkbox("包含来源和导出时间", "metadata", preferences.includeMetadata);
    const style = selectField("公式复制", "mathStyle", [["markdown", "Markdown：$ / $$"], ["latex", "LaTeX：\\( \\) / \\[ \\]"]]);
    style.select.value = clipboard.mathStyle;
    const quote = checkbox("引用兼容（默认关闭）", "quote", clipboard.quoteCompatibility);
    details.append(source.label, limit.label, metadata.label, style.label,
      element("p", "omnigpt-hint", "自动保留行内/独立公式。Alt＋双击只复制 TeX。此选项不改写 API 导出原文。"),
      quote.label, element("p", "omnigpt-hint", "仅需原生选区引用时开启。默认不改写浏览器选区方法。"));
    const actions = element("div", "omnigpt-actions");
    const download = button("导出文件", "export"); const copy = button("复制 Markdown", "copy"); const cancel = button("取消", "cancel"); cancel.hidden = true;
    actions.append(download, copy, cancel);
    const bar = element("progress"); bar.hidden = true; bar.setAttribute("aria-label", "导出进度");
    const status = element("div", "omnigpt-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const files = element("div", "omnigpt-files");
    panel.append(header, scope.label, format.label, hint, details, actions, bar, status, files);
    controls = { scope: scope.select, format: format.select, source: source.select, sourceLabel: source.label, limit: limit.select,
      limitLabel: limit.label, metadata: metadata.input, style: style.select, quote: quote.input, hint, status, files, progress: bar,
      export: download, copy, cancel };
    root.append(panel); syncControls();
    panel.addEventListener("change", () => {
      if (task) return;
      preferences = { format: controls.format.value, includeMetadata: controls.metadata.checked };
      try { global.localStorage.setItem(SETTINGS_KEY, JSON.stringify(preferences)); } catch (_) { /* Optional. */ }
      clipboard.setMathStyle(controls.style.value);
      clipboard.setQuoteCompatibility(controls.quote.checked); controls.quote.checked = clipboard.quoteCompatibility;
      syncControls();
    });
  }
  function closePanel(focus = false) {
    if (!panel || panel.hidden) return;
    panel.hidden = true; launcher.setAttribute("aria-expanded", "false");
    // Closing a running task also cancels it. No invisible network work or retained large bundle.
    task?.abort();
    controls.files.replaceChildren();
    if (focus) launcher.focus({ preventScroll: true });
  }
  async function run(action) {
    if (task || (action === "copy" && controls.scope.value === "all")) return;
    const controller = new AbortController();
    const all = controls.scope.value === "all";
    const format = action === "copy" ? "markdown" : controls.format.value;
    const options = { signal: controller.signal, source: controls.source.value, includeMetadata: controls.metadata.checked,
      maxConversations: Number(controls.limit.value), onProgress: renderProgress };
    task = controller; lastProgressAt = 0;
    controls.files.replaceChildren(); controls.progress.hidden = false; controls.progress.removeAttribute("value");
    panel.setAttribute("aria-busy", "true"); syncControls(); setStatus("准备导出…");
    try {
      const payload = all ? await exporter.getArchiveExportPayload(format, options) : await exporter.getCurrentExportPayload(format, document, options);
      if (controller.signal.aborted) return;
      if (action === "copy") await clipboard.writeText(payload.content);
      else if (payload.files?.length) {
        for (const file of payload.files) {
          const save = button(file.filename, "part");
          // Explicit downloads avoid browser multiple-download prompts and ZIP dependencies.
          save.addEventListener("click", () => exporter.createDownload(file.content, file.filename, file.mimeType));
          controls.files.append(save);
        }
      } else exporter.createDownload(payload.content, payload.filename, payload.mimeType);
      const info = payload.info || {};
      const message = action === "copy" ? "已复制 Markdown（纯文本）" : payload.files?.length ? `已生成 ${payload.files.length} 个分片，点击下方逐个保存；关闭面板会释放分片。` : `已请求下载：${payload.filename}`;
      const summary = `${info.conversationCount || 1} 个对话 / ${info.messageCount || 0} 条消息${info.failedConversations ? `；失败 ${info.failedConversations} 个（见文件明细）` : ""}`;
      setStatus([message, summary, ...(info.warnings || [])].join("\n"), info.partial || info.failedConversations ? "warning" : "info");
    } catch (error) {
      setStatus(error.name === "AbortError" ? "已取消，未继续读取或生成文件。" : error.message || "导出失败", error.name === "AbortError" ? "info" : "error");
    } finally {
      if (task === controller) task = null;
      controls.progress.hidden = true; panel.removeAttribute("aria-busy"); syncControls();
    }
  }
  function setupUi() {
    if (document.getElementById(ROOT_ID) || !exporter) return;
    injectStyles(); root = element("div"); root.id = ROOT_ID;
    launcher = element("button", "omnigpt-launcher"); launcher.type = "button";
    launcher.setAttribute("aria-label", "打开 OmniGPT"); launcher.setAttribute("aria-expanded", "false"); launcher.setAttribute("aria-controls", "omnigpt-panel");
    launcher.append(element("span", "omnigpt-mark", "O"), element("span", "omnigpt-label", "OmniGPT"));
    root.append(launcher); document.body.append(root);
    // Only the launcher exists at startup. Build the form on its first explicit opening.
    launcher.addEventListener("click", () => {
      if (!panel) buildPanel();
      if (!panel.hidden) { closePanel(true); return; }
      panel.hidden = false; launcher.setAttribute("aria-expanded", "true"); controls.scope.focus({ preventScroll: true });
    });
    root.addEventListener("click", (event) => {
      const action = event.target.closest?.("button[data-action]")?.dataset.action;
      if (action === "close") closePanel(true);
      else if (action === "cancel") { task?.abort(); setStatus("正在取消…"); }
      else if (action === "export" || action === "copy") void run(action);
    });
    document.addEventListener("click", (event) => { if (panel && !panel.hidden && !root.contains(event.target)) closePanel(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && panel && !panel.hidden) { event.preventDefault(); closePanel(true); } });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setupUi, { once: true });
  else setupUi();
})(globalThis);
