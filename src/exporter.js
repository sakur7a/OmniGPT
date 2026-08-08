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
