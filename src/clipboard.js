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

  // Follow ancestors, not a document-wide selector. A formula is an atomic selection unit.
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
    for (const attr of SOURCE_ATTRS) {
      source = node.getAttribute(attr) || "";
      if (source.trim()) break;
    }
    if (!source.trim()) source = node.querySelector(TEX_ANNOTATION)?.textContent || "";
    if (!source.trim()) {
      const carrier = node.querySelector("[data-math-source], [data-latex], [data-tex], [data-original-tex], math[alttext]");
      if (carrier) for (const attr of SOURCE_ATTRS) {
        source = carrier.getAttribute(attr) || "";
        if (source.trim()) break;
      }
    }
    let display = Boolean(node.closest('.katex-display, .MathJax_Display, [data-math-display="true"], .math-display, mjx-container[display="true"], math[display="block"]') ||
      node.querySelector('mjx-container[display="true"], math[display="block"]'));
    if (!source.trim() && node.matches("mjx-container, .MathJax")) {
      // Only consult a renderer already present on the page; never load one or send a request.
      try {
        const item = global.MathJax?.startup?.document?.getMathItemsWithin?.([node])?.[0];
        if (typeof item?.math === "string") { source = item.math; display = Boolean(item.display); }
        const legacy = global.MathJax?.Hub?.getJaxFor?.(node);
        if (!source && typeof legacy?.originalText === "string") source = legacy.originalText;
      } catch (_) { /* Renderer internals are optional. */ }
      const sibling = node.nextElementSibling;
      if (!source && sibling?.matches('script[type^="math/tex"]')) {
        source = sibling.textContent || "";
        display = display || /mode\s*=\s*display/i.test(sibling.type);
      }
    }
    display = display || /^(?:\$\$|\\\[)/.test(source.trim());
    // Spoken aria-labels and arbitrary annotations are NOT LaTeX.
    return { tex: unwrapTex(source), display };
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

  function serializeRange(range) {
    if (!eligibleRange(range)) return null;
    const tokens = [];
    // A fresh marker prevents selected literal text from being mistaken for a protected token.
    const prefix = `\uE000omnigpt-${Math.random().toString(36).slice(2)}-`;
    const protect = (value) => { tokens.push(value); return `${prefix}${tokens.length - 1}\uE001`; };
    let mathCount = 0;
    let visitedNodes = 0;
    let codeDepth = 0;
    const listPositions = new WeakMap();
    const rawText = (node) => {
      let text = node.nodeValue || "";
      const end = node === range.endContainer ? range.endOffset : text.length;
      const start = node === range.startContainer ? range.startOffset : 0;
      return text.slice(start, end);
    };
    const intersects = (node) => { try { return range.intersectsNode(node); } catch (_) { return false; } };
    const clean = (text) => text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const children = (node) => {
      // Range boundary offsets let a selection in <main> skip unrelated sibling turns entirely.
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
      if (!codeDepth && node.matches(MATH)) {
        const formula = readFormula(node);
        if (formula.tex) {
          mathCount += 1;
          const text = formula.display ? `$$\n${formula.tex}\n$$` : `$${formula.tex}$`;
          return formula.display ? `\n\n${protect(text)}\n\n` : protect(text);
        }
      }
      if (node.matches(SKIP + ", " + EDITABLE) || tag === "SCRIPT") return "";
      if (tag === "BR") return "\n";
      if (tag === "HR") return "\n\n---\n\n";
      if (tag === "PRE" || tag === "CODE") {
        if (codeDepth) return children(node);
        codeDepth += 1;
        const content = children(node);
        codeDepth -= 1;
        const longest = Math.max(0, ...(content.match(/`+/g) || []).map((run) => run.length));
        const fence = "`".repeat(Math.max(tag === "PRE" ? 3 : 1, longest + 1));
        const language = `${node.className || ""} ${node.querySelector("code")?.className || ""}`.match(/\blanguage-([\w+-]+)/)?.[1] || "";
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
        return /^(?:https?:\/\/|\/|#|mailto:)/i.test(href) ? `[${value}](${href.replace(/\)/g, "%29")})` : value;
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
        return `\n${marker}${value.trim().replace(/\n/g, "\n  ")}\n`;
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
    // Expanding only the intersected formula preserves its TeX even when selection starts inside a glyph.
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
      if (!payload?.mathCount || !payload.text) return; // Leave ordinary copy completely native.
      event.clipboardData.clearData();
      event.clipboardData.setData("text/plain", payload.text);
      event.preventDefault();
      // preventDefault alone does not prevent later page handlers from adding KaTeX HTML.
      event.stopImmediatePropagation();
    } catch (_) { /* On unexpected DOM changes leave native copy available. */ }
  }

  async function writeText(text) {
    if (global.navigator.clipboard?.writeText) {
      try { await global.navigator.clipboard.writeText(text); return; } catch (_) { /* Try a user-gesture fallback. */ }
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
        // cloneContents is deliberately never patched, even in compatibility mode.
        const safeWrapper = function () {
          try { return wrapper.call(this); } catch (_) { return native.call(this); }
        };
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "toString");
        try {
          prototype.toString = safeWrapper;
          quotePatches.push({ prototype, descriptor, wrapper: safeWrapper });
        } catch (_) { /* Some managers isolate or lock prototypes. */ }
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
    // Install at document-start, ahead of ordinary page handlers. No polling, observer or initial math scan.
    global.addEventListener("copy", handleCopy, true);
    global.addEventListener("dblclick", (event) => {
      const target = elementOf(event.target);
      if (!target?.closest(MESSAGE) || target.closest(EDITABLE)) return;
      const root = formulaRoot(target);
      if (!root) return;
      const { tex, display } = readFormula(root);
      if (!tex) return;
      event.preventDefault();
      writeText(display ? `$$\n${tex}\n$$` : `$${tex}$`)
        .then(() => onCopied("LaTeX 公式已复制"))
        .catch(() => onCopied("复制失败，请检查剪贴板权限"));
    });
    try { if (global.localStorage.getItem(QUOTE_KEY) === "true") setQuoteCompatibility(true, false); } catch (_) { /* Storage optional. */ }
  }

  global.OmniGPTClipboard = Object.freeze({ install, handleCopy, selectionPayload, serializeRange, readFormula, unwrapTex, writeText,
    setQuoteCompatibility, get quoteCompatibility() { return quoteEnabled; } });
})(globalThis);
