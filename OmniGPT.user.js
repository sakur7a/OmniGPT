// ==UserScript==
// @name         OmniGPT - ChatGPT Export & LaTeX Copy
// @name:zh-CN   OmniGPT - ChatGPT 对话导出与 LaTeX 复制
// @namespace    https://github.com/sakur7a/OmniGPT
// @version      0.1.1
// @description  Export ChatGPT conversations and preserve original LaTeX when copying or quoting formulas.
// @description:zh-CN 导出 ChatGPT 对话，并在复制或引用时保留原始 LaTeX 公式。
// @author       OmniGPT contributors
// @license      GPL-3.0-or-later
// @homepageURL  https://github.com/sakur7a/OmniGPT
// @supportURL   https://github.com/sakur7a/OmniGPT/issues
// @downloadURL  https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js
// @updateURL    https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function initExporter(global) {
  "use strict";

  const API_PAGE_SIZE = 100;
  const DETAIL_FETCH_CONCURRENCY = 4;
  const GPT_UPLOAD_TARGET_CHARS = 900000;
  const MAIN_MESSAGE_SELECTORS = [
    "main [data-message-author-role]",
    "article [data-message-author-role]",
    "[data-testid^='conversation-turn-'] [data-message-author-role]",
    "[data-message-author-role]"
  ];

  const BLOCK_TAGS = new Set([
    "article",
    "aside",
    "blockquote",
    "div",
    "dl",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "tbody",
    "thead",
    "tr",
    "ul"
  ]);

  const REMOVABLE_SELECTORS = [
    "button",
    "textarea",
    "input",
    "select",
    "nav",
    "footer",
    "script",
    "style",
    "noscript",
    "[data-testid='conversation-turn-actions']"
  ];
  let cachedSession = null;

  function getConversationTitle(doc) {
    const raw = (doc.title || "chatgpt-conversation").replace(/\s*-\s*ChatGPT\s*$/i, "").trim();
    return raw || "chatgpt-conversation";
  }

  function slugifyTitle(title) {
    const fallback = `chatgpt-conversation-${timestampForFile(new Date().toISOString())}`;
    const slug = String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return slug || fallback;
  }

  function timestampForFile(isoString) {
    return String(isoString || new Date().toISOString())
      .replace(/[:]/g, "-")
      .replace(/\.\d+Z$/, "Z");
  }

  function getBaseOrigin() {
    const origin = global.location?.origin || "https://chatgpt.com";
    return /^https:\/\/chat\.openai\.com$/i.test(origin) ? "https://chat.openai.com" : "https://chatgpt.com";
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function escapeInlineText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\*/g, "\\*")
      .replace(/_/g, "\\_")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]")
      .replace(/\|/g, "\\|");
  }

  function escapeCodeFence(text) {
    return String(text || "").replace(/```/g, "`` `");
  }

  function isElement(node) {
    return node && node.nodeType === Node.ELEMENT_NODE;
  }

  function isText(node) {
    return node && node.nodeType === Node.TEXT_NODE;
  }

  function isLikelyVisible(node) {
    if (!isElement(node)) {
      return true;
    }

    const style = global.getComputedStyle ? global.getComputedStyle(node) : null;
    if (!style) {
      return true;
    }

    return style.display !== "none" && style.visibility !== "hidden";
  }

  function cleanClone(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll(REMOVABLE_SELECTORS.join(",")).forEach((element) => {
      if (element.tagName === "BUTTON" && element.closest("pre")) {
        return;
      }
      element.remove();
    });

    clone.querySelectorAll("[class]").forEach((element) => {
      const className = element.getAttribute("class") || "";
      if (/sr-only|screen-reader|visually-hidden/i.test(className)) {
        element.remove();
      }
    });

    return clone;
  }

  function scoreCandidate(node) {
    const textLength = normalizeText(node.innerText || node.textContent || "").length;
    const richScore =
      node.querySelectorAll("pre, code, table, ul, ol, blockquote, a, img").length * 12;
    const markdownHint = /\b(markdown|prose|whitespace-pre-wrap|text-message)\b/i.test(node.className || "")
      ? 50
      : 0;
    return textLength + richScore + markdownHint;
  }

  function findBestContentNode(article) {
    const selectors = [
      "[data-message-author-role] .markdown",
      "[data-message-author-role] [class*='markdown']",
      "[data-message-author-role] .prose",
      "[data-message-author-role] [class*='prose']",
      "[data-message-author-role] .whitespace-pre-wrap",
      "[data-message-author-role] [class*='whitespace-pre-wrap']",
      "[data-message-author-role] [class*='text-message']",
      "[data-message-author-role]",
      ".markdown",
      "[class*='markdown']",
      ".prose",
      "[class*='prose']",
      ".whitespace-pre-wrap",
      "[class*='whitespace-pre-wrap']"
    ];

    const candidates = [];
    selectors.forEach((selector) => {
      article.querySelectorAll(selector).forEach((node) => {
        if (isLikelyVisible(node) && normalizeText(node.innerText || node.textContent).length > 0) {
          candidates.push(node);
        }
      });
    });

    if (!candidates.length) {
      return article;
    }

    return candidates.sort((left, right) => scoreCandidate(right) - scoreCandidate(left))[0];
  }

  function extractRole(article) {
    const roleNode = article.querySelector("[data-message-author-role]");
    const explicitRole = roleNode?.getAttribute("data-message-author-role") || article.getAttribute("data-message-author-role");
    if (explicitRole) {
      return explicitRole;
    }

    if (article.querySelector(".user-message-bubble-color")) {
      return "user";
    }

    return "assistant";
  }

  function extractRoleFromNode(node) {
    const explicitRole = node?.getAttribute("data-message-author-role");
    if (explicitRole) {
      return explicitRole;
    }

    return extractRole(node);
  }

  function extractLanguage(preElement) {
    const code = preElement.querySelector("code");
    const classTokens = `${preElement.className || ""} ${code?.className || ""}`.split(/\s+/);
    for (const token of classTokens) {
      const match = token.match(/language-([a-z0-9#+-]+)/i) || token.match(/lang(?:uage)?-([a-z0-9#+-]+)/i);
      if (match) {
        return match[1].toLowerCase();
      }
    }

    const label = Array.from(preElement.querySelectorAll("button, span, div"))
      .map((node) => normalizeText(node.textContent))
      .find((text) => /^[a-z0-9#+-]{1,20}$/i.test(text));

    return label ? label.toLowerCase() : "";
  }

  function unwrapMathDelimiters(source) {
    const value = normalizeText(source);
    if ((value.startsWith("$$") && value.endsWith("$$")) || (value.startsWith("\\[") && value.endsWith("\\]"))) {
      return value.slice(2, -2).trim();
    }
    if ((value.startsWith("$") && value.endsWith("$")) || (value.startsWith("\\(") && value.endsWith("\\)"))) {
      return value.slice(1, -1).trim();
    }
    return value;
  }

  function findRawTex(katexElement) {
    const cached = katexElement.getAttribute("data-omnigpt-tex");
    if (cached) {
      return unwrapMathDelimiters(cached);
    }

    const annotation = katexElement.querySelector('annotation[encoding="application/x-tex"], annotation');
    if (annotation?.textContent) {
      return unwrapMathDelimiters(annotation.textContent);
    }

    let candidate = katexElement;
    for (let depth = 0; candidate && depth < 6; depth += 1, candidate = candidate.parentElement) {
      for (const attribute of ["data-math-source", "data-latex", "data-tex", "data-original-tex", "alttext"]) {
        const value = candidate.getAttribute(attribute);
        if (value?.trim()) {
          return unwrapMathDelimiters(value);
        }
      }
    }

    return "";
  }

  function renderKatex(node) {
    const source = findRawTex(node);
    if (!source) {
      return normalizeText(node.getAttribute("aria-label") || node.textContent || "");
    }
    return node.closest(".katex-display") ? `\n$$\n${source}\n$$\n\n` : `$${source}$`;
  }

  function renderTextNode(node, preserveWhitespace) {
    const value = String(node.nodeValue || "");
    if (preserveWhitespace) {
      return value;
    }

    return escapeInlineText(value);
  }

  function hasBlockChild(node) {
    return Array.from(node.childNodes).some((child) => isElement(child) && BLOCK_TAGS.has(child.tagName.toLowerCase()));
  }

  function renderInlineChildren(node) {
    return Array.from(node.childNodes)
      .map((child) => renderNode(child, { preserveWhitespace: false, indent: "" }))
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
  }

  function renderList(node, indent) {
    const ordered = node.tagName.toLowerCase() === "ol";
    const items = Array.from(node.children).filter((child) => child.tagName?.toLowerCase() === "li");
    const rendered = items.map((item, index) => renderListItem(item, indent, ordered ? `${index + 1}. ` : "- "));
    return `${rendered.join("\n")}\n\n`;
  }

  function renderListItem(item, indent, marker) {
    const inlineParts = [];
    const nestedParts = [];

    Array.from(item.childNodes).forEach((child) => {
      if (isElement(child) && ["ul", "ol"].includes(child.tagName.toLowerCase())) {
        nestedParts.push(renderList(child, `${indent}  `).trimEnd());
      } else {
        inlineParts.push(renderNode(child, { preserveWhitespace: false, indent }));
      }
    });

    const inlineText = normalizeText(inlineParts.join(""));
    const lines = inlineText ? inlineText.split("\n") : [""];
    const firstLine = `${indent}${marker}${lines[0] || ""}`.trimEnd();
    const continuation = lines
      .slice(1)
      .map((line) => `${indent}${" ".repeat(marker.length)}${line}`.trimEnd())
      .join("\n");

    const segments = [firstLine];
    if (continuation) {
      segments.push(continuation);
    }
    if (nestedParts.length) {
      segments.push(nestedParts.join("\n"));
    }

    return segments.filter(Boolean).join("\n");
  }

  function renderTable(table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (!rows.length) {
      return "";
    }

    const matrix = rows.map((row) =>
      Array.from(row.children)
        .filter((cell) => ["th", "td"].includes(cell.tagName.toLowerCase()))
        .map((cell) => normalizeText(cell.innerText || cell.textContent || "").replace(/\|/g, "\\|"))
    );

    const maxColumns = Math.max(...matrix.map((row) => row.length), 0);
    if (!maxColumns) {
      return "";
    }

    const normalizedRows = matrix.map((row) => {
      const clone = row.slice();
      while (clone.length < maxColumns) {
        clone.push("");
      }
      return clone;
    });

    const header = normalizedRows[0];
    const separator = new Array(maxColumns).fill("---");
    const body = normalizedRows.slice(1);
    const lines = [
      `| ${header.join(" | ")} |`,
      `| ${separator.join(" | ")} |`
    ];

    body.forEach((row) => {
      lines.push(`| ${row.join(" | ")} |`);
    });

    return `${lines.join("\n")}\n\n`;
  }

  function renderNode(node, context) {
    if (isText(node)) {
      return renderTextNode(node, context.preserveWhitespace);
    }

    if (!isElement(node)) {
      return "";
    }

    const tag = node.tagName.toLowerCase();
    if (["script", "style", "noscript"].includes(tag)) {
      return "";
    }

    if (tag === "br") {
      return "\n";
    }

    if (tag === "hr") {
      return "\n---\n\n";
    }

    if (node.classList.contains("katex")) {
      return renderKatex(node);
    }

    if (tag === "pre") {
      const code = node.querySelector("code");
      const language = extractLanguage(node);
      const content = code ? code.textContent || "" : node.textContent || "";
      return `\n\`\`\`${language}\n${escapeCodeFence(content).replace(/\n$/, "")}\n\`\`\`\n\n`;
    }

    if (tag === "code") {
      if (node.closest("pre")) {
        return node.textContent || "";
      }
      return `\`${String(node.textContent || "").replace(/`/g, "\\`")}\``;
    }

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      const content = normalizeText(renderInlineChildren(node));
      return `${"#".repeat(level)} ${content}\n\n`;
    }

    if (tag === "p") {
      const content = normalizeText(renderInlineChildren(node));
      return content ? `${content}\n\n` : "";
    }

    if (tag === "blockquote") {
      const content = normalizeText(
        Array.from(node.childNodes)
          .map((child) => renderNode(child, { preserveWhitespace: false, indent: context.indent }))
          .join("")
      );
      if (!content) {
        return "";
      }
      return `${content
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    }

    if (tag === "ul" || tag === "ol") {
      return renderList(node, context.indent || "");
    }

    if (tag === "table") {
      return renderTable(node);
    }

    if (tag === "a") {
      const text = normalizeText(renderInlineChildren(node)) || node.getAttribute("href") || "";
      const href = node.getAttribute("href") || "";
      return href ? `[${text}](${href})` : text;
    }

    if (tag === "img") {
      const alt = node.getAttribute("alt") || "image";
      const src = node.getAttribute("src") || "";
      return src ? `![${alt}](${src})` : "";
    }

    if (tag === "strong" || tag === "b") {
      const content = normalizeText(renderInlineChildren(node));
      return content ? `**${content}**` : "";
    }

    if (tag === "em" || tag === "i") {
      const content = normalizeText(renderInlineChildren(node));
      return content ? `*${content}*` : "";
    }

    if (tag === "del" || tag === "s") {
      const content = normalizeText(renderInlineChildren(node));
      return content ? `~~${content}~~` : "";
    }

    if (tag === "li") {
      return renderListItem(node, context.indent || "", "- ");
    }

    const renderedChildren = Array.from(node.childNodes)
      .map((child) =>
        renderNode(child, {
          preserveWhitespace: context.preserveWhitespace || tag === "pre",
          indent: context.indent || ""
        })
      )
      .join("");

    if (BLOCK_TAGS.has(tag) || hasBlockChild(node)) {
      const content = normalizeText(renderedChildren);
      return content ? `${content}\n\n` : "";
    }

    return renderedChildren;
  }

  function extractMessage(article, index) {
    const role = extractRole(article);
    const contentRoot = findBestContentNode(article);
    const cleaned = cleanClone(contentRoot);
    const markdown = normalizeText(renderNode(cleaned, { preserveWhitespace: false, indent: "" }));
    const text = normalizeText(cleaned.innerText || cleaned.textContent || "");

    if (!markdown && !text) {
      return null;
    }

    return {
      index: index + 1,
      role,
      text,
      markdown
    };
  }

  function getCurrentConversationMessageNodes(doc) {
    const searchRoot = doc || global.document;
    const seen = new Set();
    const nodes = [];

    MAIN_MESSAGE_SELECTORS.forEach((selector) => {
      searchRoot.querySelectorAll(selector).forEach((node) => {
        if (!isElement(node) || seen.has(node) || !isLikelyVisible(node)) {
          return;
        }

        if (
          node.closest("#chatgpt-exporter-root") ||
          node.closest("nav") ||
          node.closest("aside") ||
          node.closest("form")
        ) {
          return;
        }

        const text = normalizeText(node.innerText || node.textContent || "");
        if (!text) {
          return;
        }

        seen.add(node);
        nodes.push(node);
      });
    });

    return nodes;
  }

  function extractMessageFromNode(node, index) {
    const cleaned = cleanClone(node);
    const markdown = normalizeText(renderNode(cleaned, { preserveWhitespace: false, indent: "" }));
    const text = normalizeText(cleaned.innerText || cleaned.textContent || "");

    if (!markdown && !text) {
      return null;
    }

    return {
      index: index + 1,
      role: extractRoleFromNode(node),
      text,
      markdown
    };
  }

  function collectConversation(doc) {
    const documentRef = doc || global.document;
    let messages = getCurrentConversationMessageNodes(documentRef)
      .map((node, index) => extractMessageFromNode(node, index))
      .filter(Boolean);

    if (!messages.length) {
      const articles = Array.from(documentRef.querySelectorAll("main article"));
      messages = articles.map((article, index) => extractMessage(article, index)).filter(Boolean);
    }

    const title = getConversationTitle(documentRef);
    const exportedAt = new Date().toISOString();

    return {
      title,
      url: global.location?.href || "",
      exportedAt,
      messageCount: messages.length,
      messages
    };
  }

  function stringifyApiPart(part) {
    if (typeof part === "string") {
      return part;
    }

    if (part == null) {
      return "";
    }

    if (Array.isArray(part)) {
      return normalizeText(part.map((item) => stringifyApiPart(item)).join("\n\n"));
    }

    if (typeof part === "object") {
      if (typeof part.text === "string") {
        return part.text;
      }

      if (Array.isArray(part.content)) {
        return normalizeText(part.content.map((item) => stringifyApiPart(item)).join("\n\n"));
      }

      if (part.content && typeof part.content === "object") {
        return stringifyApiPart(part.content);
      }

      if (Array.isArray(part.parts)) {
        return normalizeText(part.parts.map((item) => stringifyApiPart(item)).join("\n\n"));
      }

      if (part.asset_pointer) {
        return `[asset] ${part.asset_pointer}`;
      }

      if (part.url) {
        return part.url;
      }

      if (part.name) {
        return part.name;
      }
    }

    return String(part);
  }

  function extractApiMessageText(message) {
    if (!message) {
      return "";
    }

    if (typeof message.text === "string") {
      return normalizeText(message.text);
    }

    const content = message.content || {};
    if (Array.isArray(content.parts)) {
      return normalizeText(content.parts.map((part) => stringifyApiPart(part)).join("\n\n"));
    }

    if (typeof content.text === "string") {
      return normalizeText(content.text);
    }

    if (Array.isArray(message.parts)) {
      return normalizeText(message.parts.map((part) => stringifyApiPart(part)).join("\n\n"));
    }

    return "";
  }

  function normalizeApiRole(author) {
    const role = author?.role || author || "";
    if (role === "assistant" || role === "tool") {
      return "assistant";
    }
    if (role === "user") {
      return "user";
    }
    if (role === "system") {
      return "system";
    }
    return "";
  }

  function extractMessagesFromApiConversation(conversation) {
    const mapping = conversation?.mapping || {};
    const currentNode = conversation?.current_node;
    const path = [];
    const visited = new Set();
    let nodeId = currentNode;

    while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
      visited.add(nodeId);
      path.push(mapping[nodeId]);
      nodeId = mapping[nodeId].parent;
    }

    return path
      .reverse()
      .map((node, index) => {
        const role = normalizeApiRole(node?.message?.author);
        const text = extractApiMessageText(node?.message);

        if (!role || !text) {
          return null;
        }

        return {
          index: index + 1,
          role,
          text,
          markdown: text
        };
      })
      .filter(Boolean);
  }

  async function getSession(forceRefresh) {
    if (cachedSession && !forceRefresh) {
      return cachedSession;
    }

    const response = await global.fetch(`${getBaseOrigin()}/api/auth/session`, {
      credentials: "include",
      headers: {
        accept: "application/json"
      }
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Unable to read ChatGPT session (${response.status}): ${errorText || "session request failed"}`);
    }

    cachedSession = await response.json();
    return cachedSession;
  }

  async function getAccessToken(forceRefresh) {
    const session = await getSession(forceRefresh);
    const accessToken = session?.accessToken || session?.access_token;
    if (!accessToken) {
      throw new Error("Unable to get ChatGPT access token from your session. Refresh ChatGPT and try again.");
    }
    return accessToken;
  }

  async function fetchJson(pathname, options = {}) {
    const { requireAuth = false, retryWithFreshToken = true } = options;
    const headers = {
      accept: "application/json"
    };

    if (requireAuth) {
      headers.authorization = `Bearer ${await getAccessToken(false)}`;
    }

    const requestUrl = `${getBaseOrigin()}${pathname}`;
    let response = await global.fetch(requestUrl, {
      credentials: "include",
      headers
    });

    if (!response.ok && requireAuth && retryWithFreshToken && (response.status === 401 || response.status === 403)) {
      headers.authorization = `Bearer ${await getAccessToken(true)}`;
      response = await global.fetch(requestUrl, {
        credentials: "include",
        headers
      });
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Request failed (${response.status}): ${errorText || pathname}`);
    }

    return response.json();
  }

  function getConversationListItems(payload) {
    if (Array.isArray(payload)) {
      return payload;
    }

    if (Array.isArray(payload?.items)) {
      return payload.items;
    }

    if (Array.isArray(payload?.conversations)) {
      return payload.conversations;
    }

    return [];
  }

  async function fetchAllConversationSummaries() {
    const conversations = [];
    let offset = 0;

    while (true) {
      const payload = await fetchJson(
        `/backend-api/conversations?offset=${offset}&limit=${API_PAGE_SIZE}&order=updated`,
        { requireAuth: true }
      );
      const items = getConversationListItems(payload);
      if (!items.length) {
        break;
      }

      conversations.push(...items);

      if (items.length < API_PAGE_SIZE) {
        break;
      }

      offset += items.length;
    }

    return conversations;
  }

  async function fetchConversationDetail(id) {
    return fetchJson(`/backend-api/conversation/${encodeURIComponent(id)}`, { requireAuth: true });
  }

  async function collectAllConversations() {
    const summaries = await fetchAllConversationSummaries();
    if (!summaries.length) {
      throw new Error("No conversations found in your ChatGPT history.");
    }

    const exportedAt = new Date().toISOString();
    const conversations = [];
    const failures = [];

    for (let index = 0; index < summaries.length; index += DETAIL_FETCH_CONCURRENCY) {
      const batch = summaries.slice(index, index + DETAIL_FETCH_CONCURRENCY);
      const settled = await Promise.all(
        batch.map(async (summary) => {
          if (!summary?.id) {
            return null;
          }

          try {
            const detail = await fetchConversationDetail(summary.id);
            const messages = extractMessagesFromApiConversation(detail);
            return {
              id: summary.id,
              title: detail?.title || summary.title || "Untitled conversation",
              url: `${global.location.origin}/c/${summary.id}`,
              createTime: detail?.create_time || summary.create_time || null,
              updateTime: detail?.update_time || summary.update_time || null,
              messageCount: messages.length,
              messages
            };
          } catch (error) {
            failures.push({
              id: summary.id,
              title: summary.title || "Untitled conversation",
              error: error?.message || "Unknown export error"
            });
            return null;
          }
        })
      );

      settled.filter(Boolean).forEach((conversation) => {
        conversations.push(conversation);
      });
    }

    return {
      exportedAt,
      source: global.location.origin,
      totalConversations: conversations.length,
      requestedConversations: summaries.length,
      failedConversations: failures.length,
      failures,
      conversations
    };
  }

  function formatMarkdown(conversation) {
    const lines = [
      `# ${conversation.title}`,
      "",
      `- Exported at: ${conversation.exportedAt}`,
      `- Source: ${conversation.url}`,
      `- Messages: ${conversation.messageCount}`,
      ""
    ];

    conversation.messages.forEach((message) => {
      const heading = message.role === "user" ? "User" : "ChatGPT";
      lines.push(`## ${message.index}. ${heading}`);
      lines.push("");
      lines.push(message.markdown || message.text || "");
      lines.push("");
    });

    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }

  function formatText(conversation) {
    const lines = [
      conversation.title,
      `Exported at: ${conversation.exportedAt}`,
      `Source: ${conversation.url}`,
      `Messages: ${conversation.messageCount}`,
      ""
    ];

    conversation.messages.forEach((message) => {
      const heading = message.role === "user" ? "User" : "ChatGPT";
      lines.push(`[${message.index}] ${heading}`);
      lines.push(message.text || message.markdown || "");
      lines.push("");
    });

    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }

  function formatJson(conversation) {
    return `${JSON.stringify(conversation, null, 2)}\n`;
  }

  function formatRoleLabel(role) {
    if (role === "user") {
      return "User";
    }
    if (role === "system") {
      return "System";
    }
    return "ChatGPT";
  }

  function formatConversationForGptImport(conversation, conversationIndex) {
    const lines = [
      `## Conversation ${conversationIndex + 1}: ${conversation.title}`,
      ""
    ];

    if (conversation.url) {
      lines.push(`- URL: ${conversation.url}`);
    }
    if (conversation.createTime) {
      lines.push(`- Created: ${conversation.createTime}`);
    }
    if (conversation.updateTime) {
      lines.push(`- Updated: ${conversation.updateTime}`);
    }
    if (conversation.messageCount != null) {
      lines.push(`- Messages: ${conversation.messageCount}`);
    }
    lines.push("");

    conversation.messages.forEach((message) => {
      lines.push(`### ${message.index}. ${formatRoleLabel(message.role)}`);
      lines.push("");
      lines.push(message.markdown || message.text || "");
      lines.push("");
    });

    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n\n`;
  }

  function buildGptImportIntro(summaryLines) {
    return [
      "# GPT Import Bundle",
      "",
      "This file is intended to be uploaded into ChatGPT, a Project, or GPT knowledge as reference material.",
      "It is not a native ChatGPT history restore file.",
      "",
      "Recommended prompt after upload:",
      "\"Use this file as prior conversation history and answer based on it. When useful, cite the conversation title and message number.\"",
      "",
      ...summaryLines,
      ""
    ].join("\n");
  }

  function formatConversationAsGptImport(conversation) {
    const gptConversation = {
      title: conversation.title,
      url: conversation.url,
      exportedAt: conversation.exportedAt,
      createTime: conversation.createTime || null,
      updateTime: conversation.updateTime || null,
      messageCount: conversation.messageCount,
      messages: conversation.messages
    };

    return (
      `${buildGptImportIntro([
        `- Title: ${conversation.title}`,
        `- Exported at: ${conversation.exportedAt}`,
        `- Source: ${conversation.url}`,
        `- Messages: ${conversation.messageCount}`
      ])}\n${formatConversationForGptImport(gptConversation, 0)}`
        .replace(/\n{3,}/g, "\n\n")
        .trim() + "\n"
    );
  }

  function buildArchiveGptImportFiles(archive, baseName) {
    const files = [];
    const headerLines = [
      `- Exported at: ${archive.exportedAt}`,
      `- Source: ${archive.source}`,
      `- Conversations exported: ${archive.totalConversations}`,
      `- Conversations requested: ${archive.requestedConversations}`,
      `- Conversations failed: ${archive.failedConversations}`
    ];
    let partNumber = 1;
    let current = buildGptImportIntro(headerLines);

    archive.conversations.forEach((conversation, index) => {
      const section = formatConversationForGptImport(conversation, index);
      if (current.length + section.length > GPT_UPLOAD_TARGET_CHARS && current.length > 0) {
        files.push({
          filename: `${baseName}-gpt-import-part-${String(partNumber).padStart(2, "0")}.md`,
          mimeType: "text/markdown;charset=utf-8",
          content: `${current.trim()}\n`
        });
        partNumber += 1;
        current = buildGptImportIntro([
          ...headerLines,
          `- File part: ${partNumber}`
        ]);
      }

      current += section;
    });

    if (archive.failures.length) {
      current += "## Failed Conversations\n\n";
      archive.failures.forEach((failure, index) => {
        current += `${index + 1}. ${failure.title} (${failure.id})\n`;
        current += `   ${failure.error}\n`;
      });
      current += "\n";
    }

    files.push({
      filename: `${baseName}-gpt-import-part-${String(partNumber).padStart(2, "0")}.md`,
      mimeType: "text/markdown;charset=utf-8",
      content: `${current.trim()}\n`
    });

    return files;
  }

  function formatAllMarkdown(archive) {
    const lines = [
      "# ChatGPT Archive",
      "",
      `- Exported at: ${archive.exportedAt}`,
      `- Source: ${archive.source}`,
      `- Conversations: ${archive.totalConversations}`,
      `- Requested: ${archive.requestedConversations}`,
      `- Failed: ${archive.failedConversations}`,
      ""
    ];

    archive.conversations.forEach((conversation, conversationIndex) => {
      lines.push(`## ${conversationIndex + 1}. ${conversation.title}`);
      lines.push("");
      lines.push(`- URL: ${conversation.url}`);
      if (conversation.createTime) {
        lines.push(`- Created: ${conversation.createTime}`);
      }
      if (conversation.updateTime) {
        lines.push(`- Updated: ${conversation.updateTime}`);
      }
      lines.push(`- Messages: ${conversation.messageCount}`);
      lines.push("");

      conversation.messages.forEach((message) => {
        const heading = message.role === "user" ? "User" : message.role === "system" ? "System" : "ChatGPT";
        lines.push(`### ${message.index}. ${heading}`);
        lines.push("");
        lines.push(message.markdown || message.text || "");
        lines.push("");
      });
    });

    if (archive.failures.length) {
      lines.push("## Failed Conversations");
      lines.push("");
      archive.failures.forEach((failure, index) => {
        lines.push(`${index + 1}. ${failure.title} (${failure.id})`);
        lines.push(`   ${failure.error}`);
      });
      lines.push("");
    }

    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }

  function formatAllText(archive) {
    const lines = [
      "ChatGPT Archive",
      `Exported at: ${archive.exportedAt}`,
      `Source: ${archive.source}`,
      `Conversations: ${archive.totalConversations}`,
      `Requested: ${archive.requestedConversations}`,
      `Failed: ${archive.failedConversations}`,
      ""
    ];

    archive.conversations.forEach((conversation, conversationIndex) => {
      lines.push(`[Conversation ${conversationIndex + 1}] ${conversation.title}`);
      lines.push(`URL: ${conversation.url}`);
      if (conversation.createTime) {
        lines.push(`Created: ${conversation.createTime}`);
      }
      if (conversation.updateTime) {
        lines.push(`Updated: ${conversation.updateTime}`);
      }
      lines.push(`Messages: ${conversation.messageCount}`);
      lines.push("");

      conversation.messages.forEach((message) => {
        const heading = message.role === "user" ? "User" : message.role === "system" ? "System" : "ChatGPT";
        lines.push(`[${message.index}] ${heading}`);
        lines.push(message.text || message.markdown || "");
        lines.push("");
      });
    });

    if (archive.failures.length) {
      lines.push("Failed conversations:");
      archive.failures.forEach((failure, index) => {
        lines.push(`${index + 1}. ${failure.title} (${failure.id})`);
        lines.push(failure.error);
      });
      lines.push("");
    }

    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }

  function createDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const link = global.document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    global.document.body.appendChild(link);
    link.click();
    link.remove();
    global.setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
  }

  function getExportPayload(format, doc) {
    const conversation = collectConversation(doc);
    if (!conversation.messageCount) {
      throw new Error("No conversation messages found on this page.");
    }

    const baseName = `${slugifyTitle(conversation.title)}-${timestampForFile(conversation.exportedAt)}`;
    if (format === "json") {
      return {
        content: formatJson(conversation),
        filename: `${baseName}.json`,
        mimeType: "application/json;charset=utf-8"
      };
    }

    if (format === "txt") {
      return {
        content: formatText(conversation),
        filename: `${baseName}.txt`,
        mimeType: "text/plain;charset=utf-8"
      };
    }

    if (format === "gptbundle") {
      return {
        content: formatConversationAsGptImport(conversation),
        filename: `${baseName}-gpt-import.md`,
        mimeType: "text/markdown;charset=utf-8"
      };
    }

    return {
      content: formatMarkdown(conversation),
      filename: `${baseName}.md`,
      mimeType: "text/markdown;charset=utf-8"
    };
  }

  async function getArchiveExportPayload(format) {
    const archive = await collectAllConversations();
    const baseName = `chatgpt-archive-${timestampForFile(archive.exportedAt)}`;

    if (format === "json") {
      return {
        content: formatJson(archive),
        filename: `${baseName}.json`,
        mimeType: "application/json;charset=utf-8"
      };
    }

    if (format === "txt") {
      return {
        content: formatAllText(archive),
        filename: `${baseName}.txt`,
        mimeType: "text/plain;charset=utf-8"
      };
    }

    if (format === "gptbundle") {
      const files = buildArchiveGptImportFiles(archive, baseName);
      return {
        files,
        detail: files.length === 1 ? files[0].filename : `${files.length} GPT import files`
      };
    }

    return {
      content: formatAllMarkdown(archive),
      filename: `${baseName}.md`,
      mimeType: "text/markdown;charset=utf-8"
    };
  }

  global.ChatGPTExporter = {
    collectConversation,
    collectAllConversations,
    createDownload,
    formatAllMarkdown,
    formatAllText,
    formatJson,
    formatMarkdown,
    formatText,
    getArchiveExportPayload,
    getConversationTitle,
    getExportPayload,
    slugifyTitle
  };
})(globalThis);

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
      .omnigpt-launcher{display:flex;align-items:center;justify-content:center;gap:8px;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:#111;color:#fff;padding:10px 16px;font-weight:700;box-shadow:0 10px 30px rgba(0,0,0,.25);cursor:pointer;transition:background-color .16s,border-color .16s,transform .16s}
      .omnigpt-launcher:hover{background:#1b1b1b;border-color:rgba(255,255,255,.28)}
      .omnigpt-launcher:focus-visible{outline:2px solid #8ee3ad;outline-offset:3px}
      .omnigpt-mark{display:none;font-size:15px;font-weight:800;line-height:1}
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
      @media (max-width:1100px){
        #${ROOT_ID}{right:10px;top:50%;bottom:auto;transform:translateY(-50%)}
        .omnigpt-launcher{width:40px;height:40px;padding:0;box-shadow:0 8px 24px rgba(0,0,0,.3)}
        .omnigpt-mark{display:block}
        .omnigpt-label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
        .omnigpt-panel{right:50px;top:50%;bottom:auto;transform:translateY(-50%);max-height:calc(100vh - 24px);overflow:auto}
      }
      @media (max-width:370px){.omnigpt-panel{width:calc(100vw - 70px)}}
      @media (prefers-reduced-motion:reduce){.omnigpt-launcher{transition:none}}
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
      <button type="button" class="omnigpt-launcher" aria-label="打开 OmniGPT" aria-expanded="false">
        <span class="omnigpt-mark" aria-hidden="true">O</span>
        <span class="omnigpt-label">OmniGPT</span>
      </button>
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
