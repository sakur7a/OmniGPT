(function initExporter(global) {
  "use strict";

  const API_PAGE_SIZE = 100;
  const DETAIL_FETCH_CONCURRENCY = 4;
  const GPT_UPLOAD_TARGET_CHARS = 900000;
  const SESSION_TTL_MS = 4 * 60 * 1000;
  const AUTH_RETRY_STATUSES = new Set([401, 403, 404]);
  const ACCOUNT_HEADER_NAMES = ["chatgpt-account-id", "openai-account-id"];
  const MATH_SELECTOR = ".katex, mjx-container, math, [data-math-source], [data-latex], [data-tex], [data-original-tex]";
  const MAIN_MESSAGE_SELECTORS = [
    "main section[data-turn='user']",
    "main section[data-turn='assistant']",
    "main [data-testid^='conversation-turn-']",
    "main [data-message-author-role]",
    "section[data-turn='user']",
    "section[data-turn='assistant']",
    "[data-testid^='conversation-turn-']",
    "[data-message-author-role]"
  ];
  const BLOCK_TAGS = new Set([
    "article", "aside", "blockquote", "div", "dl", "fieldset", "figcaption", "figure", "footer",
    "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav",
    "ol", "p", "pre", "section", "table", "tbody", "thead", "tr", "ul"
  ]);
  const REMOVABLE_SELECTORS = [
    "button", "textarea", "input", "select", "nav", "footer", "script", "style", "noscript",
    "[data-testid='conversation-turn-actions']"
  ];

  let cachedSession = null;
  let cachedSessionAt = 0;
  let cachedApiScope = null;

  function normalizeText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function timestampForFile(isoString) {
    return String(isoString || new Date().toISOString())
      .replace(/[:]/g, "-")
      .replace(/\.\d+Z$/, "Z");
  }

  function getConversationTitle(doc) {
    const raw = (doc?.title || "chatgpt-conversation").replace(/\s*-\s*ChatGPT\s*$/i, "").trim();
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

  function getBaseOrigin() {
    const origin = global.location?.origin || "https://chatgpt.com";
    return /^https:\/\/chat\.openai\.com$/i.test(origin) ? "https://chat.openai.com" : "https://chatgpt.com";
  }

  function getConversationIdFromLocation(locationLike = global.location) {
    const pathname = locationLike?.pathname || (() => {
      try { return new URL(locationLike?.href || "", getBaseOrigin()).pathname; } catch (_) { return ""; }
    })();
    for (const pattern of [/\/c\/([^/?#]+)/i, /\/g\/[^/]+\/c\/([^/?#]+)/i]) {
      const match = pathname.match(pattern);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
    return "";
  }

  function isElement(node) { return Boolean(node && node.nodeType === 1); }
  function isText(node) { return Boolean(node && node.nodeType === 3); }

  function isLikelyVisible(node) {
    if (!isElement(node) || !global.getComputedStyle) return true;
    const style = global.getComputedStyle(node);
    return !style || (style.display !== "none" && style.visibility !== "hidden");
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

  function unwrapMathDelimiters(source) {
    let value = normalizeText(source).replace(/^latex\s*:\s*/i, "");
    if ((value.startsWith("$$") && value.endsWith("$$")) || (value.startsWith("\\[") && value.endsWith("\\]"))) {
      value = value.slice(2, -2);
    } else if ((value.startsWith("$") && value.endsWith("$")) || (value.startsWith("\\(") && value.endsWith("\\)"))) {
      value = value.slice(1, -1);
    }
    return value.trim();
  }

  function findRawTex(element) {
    if (!isElement(element)) return "";
    const annotation = element.querySelector?.('annotation[encoding="application/x-tex"], annotation');
    if (annotation?.textContent?.trim()) return unwrapMathDelimiters(annotation.textContent);
    let candidate = element;
    for (let depth = 0; candidate && depth < 7; depth += 1, candidate = candidate.parentElement) {
      for (const attr of ["data-omnigpt-tex", "data-math-source", "data-latex", "data-tex", "data-original-tex", "alttext"]) {
        const value = candidate.getAttribute?.(attr);
        if (value?.trim()) return unwrapMathDelimiters(value);
      }
    }
    if (element.matches?.(".katex, math")) {
      const aria = element.getAttribute("aria-label");
      if (aria?.trim()) return unwrapMathDelimiters(aria);
    }
    return "";
  }

  function isDisplayMath(element) {
    return Boolean(
      element?.closest?.(".katex-display") ||
      element?.matches?.("mjx-container[display='true'], math[display='block']") ||
      element?.closest?.("[data-math-display='true'], .math-display")
    );
  }

  function renderFormula(node) {
    const source = findRawTex(node);
    if (!source) return normalizeText(node.getAttribute?.("aria-label") || node.textContent || "");
    return isDisplayMath(node) ? `\n$$\n${source}\n$$\n\n` : `$${source}$`;
  }

  function cleanClone(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll?.(REMOVABLE_SELECTORS.join(",")).forEach((element) => {
      if (element.tagName === "BUTTON" && element.closest("pre")) return;
      element.remove();
    });
    clone.querySelectorAll?.("[class]").forEach((element) => {
      if (/sr-only|screen-reader|visually-hidden/i.test(element.getAttribute("class") || "")) element.remove();
    });
    return clone;
  }

  function scoreCandidate(node) {
    const textLength = normalizeText(node.innerText || node.textContent || "").length;
    const richScore = node.querySelectorAll?.("pre, code, table, ul, ol, blockquote, a, img").length * 12 || 0;
    const markdownHint = /\b(markdown|prose|whitespace-pre-wrap|text-message)\b/i.test(node.className || "") ? 50 : 0;
    return textLength + richScore + markdownHint;
  }

  function findBestContentNode(turn) {
    const selectors = [
      ".markdown", "[class*='markdown']", ".prose", "[class*='prose']", ".whitespace-pre-wrap",
      "[class*='whitespace-pre-wrap']", "[class*='text-message']", "[data-message-author-role]"
    ];
    const candidates = [];
    selectors.forEach((selector) => turn.querySelectorAll?.(selector).forEach((node) => {
      if (isLikelyVisible(node) && normalizeText(node.innerText || node.textContent).length) candidates.push(node);
    }));
    if (!candidates.length) return turn;
    return candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a))[0];
  }

  function extractRoleFromNode(node) {
    const dataTurn = node.getAttribute?.("data-turn") || node.closest?.("[data-turn]")?.getAttribute("data-turn");
    if (dataTurn === "user" || dataTurn === "assistant") return dataTurn;
    const explicit = node.getAttribute?.("data-message-author-role") ||
      node.querySelector?.("[data-message-author-role]")?.getAttribute("data-message-author-role");
    if (explicit) return explicit === "tool" ? "assistant" : explicit;
    return node.querySelector?.(".user-message-bubble-color") ? "user" : "assistant";
  }

  function extractLanguage(preElement) {
    const code = preElement.querySelector?.("code");
    const tokens = `${preElement.className || ""} ${code?.className || ""}`.split(/\s+/);
    for (const token of tokens) {
      const match = token.match(/(?:language|lang)-([a-z0-9#+-]+)/i);
      if (match) return match[1].toLowerCase();
    }
    return "";
  }

  function hasBlockChild(node) {
    return Array.from(node.childNodes || []).some((child) => isElement(child) && BLOCK_TAGS.has(child.tagName.toLowerCase()));
  }

  function renderInlineChildren(node) {
    return Array.from(node.childNodes || [])
      .map((child) => renderNode(child, { preserveWhitespace: false, indent: "" }))
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
  }

  function renderListItem(item, indent, marker) {
    const inlineParts = [];
    const nestedParts = [];
    Array.from(item.childNodes || []).forEach((child) => {
      if (isElement(child) && ["ul", "ol"].includes(child.tagName.toLowerCase())) {
        nestedParts.push(renderList(child, `${indent}  `).trimEnd());
      } else {
        inlineParts.push(renderNode(child, { preserveWhitespace: false, indent }));
      }
    });
    const lines = normalizeText(inlineParts.join(""))?.split("\n") || [""];
    const segments = [`${indent}${marker}${lines[0] || ""}`.trimEnd()];
    if (lines.length > 1) {
      segments.push(lines.slice(1).map((line) => `${indent}${" ".repeat(marker.length)}${line}`.trimEnd()).join("\n"));
    }
    if (nestedParts.length) segments.push(nestedParts.join("\n"));
    return segments.filter(Boolean).join("\n");
  }

  function renderList(node, indent) {
    const ordered = node.tagName.toLowerCase() === "ol";
    const items = Array.from(node.children || []).filter((child) => child.tagName?.toLowerCase() === "li");
    return `${items.map((item, index) => renderListItem(item, indent, ordered ? `${index + 1}. ` : "- ")).join("\n")}\n\n`;
  }

  function renderTable(table) {
    const rows = Array.from(table.querySelectorAll?.("tr") || []);
    if (!rows.length) return "";
    const matrix = rows.map((row) => Array.from(row.children || [])
      .filter((cell) => ["th", "td"].includes(cell.tagName.toLowerCase()))
      .map((cell) => normalizeText(cell.innerText || cell.textContent || "").replace(/\|/g, "\\|")));
    const columns = Math.max(0, ...matrix.map((row) => row.length));
    if (!columns) return "";
    const normalized = matrix.map((row) => [...row, ...new Array(columns - row.length).fill("")]);
    const lines = [`| ${normalized[0].join(" | ")} |`, `| ${new Array(columns).fill("---").join(" | ")} |`];
    normalized.slice(1).forEach((row) => lines.push(`| ${row.join(" | ")} |`));
    return `${lines.join("\n")}\n\n`;
  }

  function renderNode(node, context) {
    if (isText(node)) return context.preserveWhitespace ? String(node.nodeValue || "") : escapeInlineText(node.nodeValue || "");
    if (!isElement(node)) return "";
    const tag = node.tagName.toLowerCase();
    if (["script", "style", "noscript"].includes(tag)) return "";
    if (node.matches?.(MATH_SELECTOR)) return renderFormula(node);
    if (tag === "br") return "\n";
    if (tag === "hr") return "\n---\n\n";
    if (tag === "pre") {
      const code = node.querySelector?.("code");
      const content = code ? code.textContent || "" : node.textContent || "";
      return `\n\`\`\`${extractLanguage(node)}\n${String(content).replace(/```/g, "`` `").replace(/\n$/, "")}\n\`\`\`\n\n`;
    }
    if (tag === "code") return node.closest?.("pre") ? node.textContent || "" : `\`${String(node.textContent || "").replace(/`/g, "\\`")}\``;
    if (/^h[1-6]$/.test(tag)) return `${"#".repeat(Number(tag.slice(1)))} ${normalizeText(renderInlineChildren(node))}\n\n`;
    if (tag === "p") {
      const content = normalizeText(renderInlineChildren(node));
      return content ? `${content}\n\n` : "";
    }
    if (tag === "blockquote") {
      const content = normalizeText(Array.from(node.childNodes || []).map((child) => renderNode(child, context)).join(""));
      return content ? `${content.split("\n").map((line) => `> ${line}`).join("\n")}\n\n` : "";
    }
    if (tag === "ul" || tag === "ol") return renderList(node, context.indent || "");
    if (tag === "table") return renderTable(node);
    if (tag === "a") {
      const text = normalizeText(renderInlineChildren(node)) || node.getAttribute("href") || "";
      const href = node.getAttribute("href") || "";
      return href ? `[${text}](${href})` : text;
    }
    if (tag === "img") {
      const src = node.getAttribute("src") || "";
      return src ? `![${node.getAttribute("alt") || "image"}](${src})` : "";
    }
    if (tag === "strong" || tag === "b") return `**${normalizeText(renderInlineChildren(node))}**`;
    if (tag === "em" || tag === "i") return `*${normalizeText(renderInlineChildren(node))}*`;
    if (tag === "del" || tag === "s") return `~~${normalizeText(renderInlineChildren(node))}~~`;
    if (tag === "li") return renderListItem(node, context.indent || "", "- ");
    const rendered = Array.from(node.childNodes || []).map((child) => renderNode(child, {
      preserveWhitespace: context.preserveWhitespace || tag === "pre",
      indent: context.indent || ""
    })).join("");
    if (BLOCK_TAGS.has(tag) || hasBlockChild(node)) {
      const content = normalizeText(rendered);
      return content ? `${content}\n\n` : "";
    }
    return rendered;
  }

  function canonicalTurnNode(node) {
    return node.closest?.("section[data-turn], [data-testid^='conversation-turn-']") || node;
  }

  function getCurrentConversationMessageNodes(doc) {
    const root = doc || global.document;
    const seen = new Set();
    const nodes = [];
    MAIN_MESSAGE_SELECTORS.forEach((selector) => root.querySelectorAll?.(selector).forEach((candidate) => {
      const node = canonicalTurnNode(candidate);
      if (!isElement(node) || seen.has(node) || !isLikelyVisible(node)) return;
      if (node.closest?.(`#omnigpt-root, nav, aside, form`)) return;
      if (!normalizeText(node.innerText || node.textContent || "")) return;
      seen.add(node);
      nodes.push(node);
    }));
    return nodes;
  }

  function extractMessageFromNode(node, index) {
    const contentRoot = findBestContentNode(node);
    const cleaned = cleanClone(contentRoot);
    const markdown = normalizeText(renderNode(cleaned, { preserveWhitespace: false, indent: "" }));
    const text = normalizeText(cleaned.innerText || cleaned.textContent || "");
    if (!markdown && !text) return null;
    return { index: index + 1, role: extractRoleFromNode(node), text, markdown };
  }

  function collectConversation(doc) {
    const documentRef = doc || global.document;
    const messages = getCurrentConversationMessageNodes(documentRef)
      .map((node, index) => extractMessageFromNode(node, index))
      .filter(Boolean);
    return {
      title: getConversationTitle(documentRef),
      url: global.location?.href || "",
      exportedAt: new Date().toISOString(),
      messageCount: messages.length,
      messages
    };
  }

  function stringifyApiPart(part) {
    if (typeof part === "string") return part;
    if (part == null) return "";
    if (Array.isArray(part)) return normalizeText(part.map(stringifyApiPart).join("\n\n"));
    if (typeof part === "object") {
      if (typeof part.text === "string") return part.text;
      if (Array.isArray(part.content)) return normalizeText(part.content.map(stringifyApiPart).join("\n\n"));
      if (part.content && typeof part.content === "object") return stringifyApiPart(part.content);
      if (Array.isArray(part.parts)) return normalizeText(part.parts.map(stringifyApiPart).join("\n\n"));
      if (part.asset_pointer) return `[asset] ${part.asset_pointer}`;
      if (part.url) return part.url;
      if (part.name) return part.name;
    }
    return String(part);
  }

  function extractApiMessageText(message) {
    if (!message) return "";
    if (typeof message.text === "string") return normalizeText(message.text);
    const content = message.content || {};
    if (Array.isArray(content.parts)) return normalizeText(content.parts.map(stringifyApiPart).join("\n\n"));
    if (typeof content.text === "string") return normalizeText(content.text);
    if (Array.isArray(message.parts)) return normalizeText(message.parts.map(stringifyApiPart).join("\n\n"));
    return "";
  }

  function normalizeApiRole(author) {
    const role = author?.role || author || "";
    if (role === "assistant" || role === "tool") return "assistant";
    if (role === "user" || role === "system") return role;
    return "";
  }

  function extractMessagesFromApiConversation(conversation) {
    const mapping = conversation?.mapping || {};
    const path = [];
    const visited = new Set();
    let nodeId = conversation?.current_node;
    while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
      visited.add(nodeId);
      path.push(mapping[nodeId]);
      nodeId = mapping[nodeId].parent;
    }
    let nodes = path.reverse();
    if (!nodes.length) {
      nodes = Object.values(mapping).filter((node) => node?.message).sort((a, b) =>
        Number(a.message?.create_time || 0) - Number(b.message?.create_time || 0));
    }
    return nodes.map((node) => {
      const role = normalizeApiRole(node?.message?.author);
      const text = extractApiMessageText(node?.message);
      if (!role || !text) return null;
      return { role, text, markdown: text };
    }).filter(Boolean).map((message, index) => ({ ...message, index: index + 1 }));
  }

  async function getSession(forceRefresh = false) {
    const freshEnough = cachedSession && Date.now() - cachedSessionAt < SESSION_TTL_MS;
    if (freshEnough && !forceRefresh) return cachedSession;
    const response = await global.fetch(`${getBaseOrigin()}/api/auth/session`, {
      credentials: "include",
      headers: { accept: "application/json" }
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const error = new Error(`Unable to read ChatGPT session (${response.status}): ${errorText || "session request failed"}`);
      error.status = response.status;
      throw error;
    }
    cachedSession = await response.json();
    cachedSessionAt = Date.now();
    return cachedSession;
  }

  async function getAccessToken(forceRefresh = false) {
    try {
      const session = await getSession(forceRefresh);
      return session?.accessToken || session?.access_token || null;
    } catch (error) {
      console.warn("[OmniGPT] Unable to refresh ChatGPT session; trying cookie auth.", error);
      return null;
    }
  }

  function addAccountId(value, ids) {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed && trimmed.length >= 6 && trimmed.length <= 160 && !/\s/.test(trimmed)) ids.add(trimmed);
  }

  function collectAccountIdsDeep(value, ids, keyHint = "", depth = 0) {
    if (depth > 7 || value == null) return;
    if (typeof value === "string") {
      if (/account|workspace|organization|org|team/i.test(keyHint)) addAccountId(value, ids);
      const matches = value.match(/\b(?:account|workspace|org|team)-[A-Za-z0-9_-]{6,}\b/g) || [];
      matches.forEach((match) => ids.add(match));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectAccountIdsDeep(item, ids, keyHint, depth + 1));
      return;
    }
    if (typeof value === "object") {
      Object.entries(value).forEach(([key, nested]) => collectAccountIdsDeep(nested, ids, key, depth + 1));
    }
  }

  async function getAccountIds(forceRefresh = false) {
    const ids = new Set();
    try { collectAccountIdsDeep(await getSession(forceRefresh), ids); } catch (_) {}
    for (const storage of [global.localStorage, global.sessionStorage]) {
      if (!storage) continue;
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          const value = storage.getItem(key);
          collectAccountIdsDeep(value, ids, key || "storage");
          try { collectAccountIdsDeep(JSON.parse(value), ids); } catch (_) {}
        }
      } catch (_) {}
    }
    return [...ids].slice(0, 6);
  }

  function buildHeaders(token, scope) {
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (scope?.accountId && scope?.headerName) headers[scope.headerName] = scope.accountId;
    return headers;
  }

  async function request(pathname, token, scope) {
    return global.fetch(`${getBaseOrigin()}${pathname}`, {
      credentials: "include",
      headers: buildHeaders(token, scope)
    });
  }

  async function responseError(response, pathname) {
    const errorText = await response.text().catch(() => "");
    const error = new Error(`Request failed (${response.status}): ${errorText || pathname}`);
    error.status = response.status;
    error.pathname = pathname;
    return error;
  }

  async function fetchJson(pathname, options = {}) {
    const { requireAuth = false, retryWithFreshToken = true } = options;
    let token = requireAuth ? await getAccessToken(false) : null;
    let response = await request(pathname, token, cachedApiScope);
    if (response.ok) return response.json();

    if (requireAuth && retryWithFreshToken && AUTH_RETRY_STATUSES.has(response.status)) {
      token = await getAccessToken(true);
      response = await request(pathname, token, cachedApiScope);
      if (response.ok) return response.json();
    }

    if (response.status === 404 && pathname.startsWith("/backend-api/")) {
      const accountIds = await getAccountIds(false);
      for (const accountId of accountIds) {
        for (const headerName of ACCOUNT_HEADER_NAMES) {
          const scope = { accountId, headerName };
          const scopedResponse = await request(pathname, token, scope);
          if (scopedResponse.ok) {
            cachedApiScope = scope;
            return scopedResponse.json();
          }
          response = scopedResponse;
        }
      }
    }

    throw await responseError(response, pathname);
  }

  function getConversationListItems(payload) {
    if (Array.isArray(payload)) return payload;
    for (const key of ["items", "conversations", "data"]) {
      if (Array.isArray(payload?.[key])) return payload[key];
    }
    return [];
  }

  async function fetchAllConversationSummaries() {
    const conversations = [];
    let offset = 0;
    while (true) {
      const payload = await fetchJson(`/backend-api/conversations?offset=${offset}&limit=${API_PAGE_SIZE}&order=updated`, { requireAuth: true });
      const items = getConversationListItems(payload);
      if (!items.length) break;
      conversations.push(...items);
      if (payload?.has_more === false || items.length < API_PAGE_SIZE) break;
      offset += items.length;
    }
    return conversations;
  }

  async function fetchConversationDetail(id) {
    let firstError = null;
    for (const pathname of [
      `/backend-api/conversation/${encodeURIComponent(id)}`,
      `/backend-api/conversations/${encodeURIComponent(id)}`
    ]) {
      try { return await fetchJson(pathname, { requireAuth: true }); }
      catch (error) {
        firstError ||= error;
        if (![404, 405].includes(error?.status)) throw error;
      }
    }
    throw firstError || new Error(`Unable to fetch conversation ${id}`);
  }

  function conversationFromApi(detail, summary = {}) {
    const messages = extractMessagesFromApiConversation(detail);
    const id = detail?.id || detail?.conversation_id || summary?.id || summary?.conversation_id || "";
    return {
      id,
      title: detail?.title || summary?.title || "Untitled conversation",
      url: id ? `${global.location?.origin || getBaseOrigin()}/c/${id}` : global.location?.href || "",
      exportedAt: new Date().toISOString(),
      createTime: detail?.create_time || summary?.create_time || null,
      updateTime: detail?.update_time || summary?.update_time || null,
      messageCount: messages.length,
      messages
    };
  }

  async function collectCurrentConversation(doc) {
    const id = getConversationIdFromLocation();
    if (id) {
      try {
        const detail = await fetchConversationDetail(id);
        const conversation = conversationFromApi(detail, { id, title: getConversationTitle(doc || global.document) });
        if (conversation.messageCount) return conversation;
      } catch (error) {
        console.warn("[OmniGPT] API-first current export failed; falling back to DOM.", error);
      }
    }
    return collectConversation(doc || global.document);
  }

  async function collectAllConversations() {
    const summaries = await fetchAllConversationSummaries();
    if (!summaries.length) throw new Error("No conversations found in your ChatGPT history.");
    const conversations = [];
    const failures = [];
    for (let index = 0; index < summaries.length; index += DETAIL_FETCH_CONCURRENCY) {
      const batch = summaries.slice(index, index + DETAIL_FETCH_CONCURRENCY);
      const settled = await Promise.all(batch.map(async (summary) => {
        const id = summary?.id || summary?.conversation_id;
        if (!id) return null;
        try { return conversationFromApi(await fetchConversationDetail(id), summary); }
        catch (error) {
          failures.push({ id, title: summary.title || "Untitled conversation", error: error?.message || "Unknown export error" });
          return null;
        }
      }));
      settled.filter(Boolean).forEach((conversation) => conversations.push(conversation));
    }
    return {
      exportedAt: new Date().toISOString(),
      source: global.location?.origin || getBaseOrigin(),
      totalConversations: conversations.length,
      requestedConversations: summaries.length,
      failedConversations: failures.length,
      failures,
      conversations
    };
  }

  function formatRoleLabel(role) {
    if (role === "user") return "User";
    if (role === "system") return "System";
    return "ChatGPT";
  }

  function formatMarkdown(conversation) {
    const lines = [
      `# ${conversation.title}`, "", `- Exported at: ${conversation.exportedAt}`,
      `- Source: ${conversation.url}`, `- Messages: ${conversation.messageCount}`, ""
    ];
    conversation.messages.forEach((message) => {
      lines.push(`## ${message.index}. ${formatRoleLabel(message.role)}`, "", message.markdown || message.text || "", "");
    });
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }

  function formatText(conversation) {
    const lines = [conversation.title, `Exported at: ${conversation.exportedAt}`, `Source: ${conversation.url}`, `Messages: ${conversation.messageCount}`, ""];
    conversation.messages.forEach((message) => {
      lines.push(`[${message.index}] ${formatRoleLabel(message.role)}`, message.text || message.markdown || "", "");
    });
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }

  function formatJson(value) { return `${JSON.stringify(value, null, 2)}\n`; }

  function formatConversationForGptImport(conversation, conversationIndex) {
    const lines = [`## Conversation ${conversationIndex + 1}: ${conversation.title}`, ""];
    if (conversation.url) lines.push(`- URL: ${conversation.url}`);
    if (conversation.createTime) lines.push(`- Created: ${conversation.createTime}`);
    if (conversation.updateTime) lines.push(`- Updated: ${conversation.updateTime}`);
    lines.push(`- Messages: ${conversation.messageCount}`, "");
    conversation.messages.forEach((message) => {
      lines.push(`### ${message.index}. ${formatRoleLabel(message.role)}`, "", message.markdown || message.text || "", "");
    });
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n\n`;
  }

  function buildGptImportIntro(summaryLines) {
    return [
      "# GPT Import Bundle", "",
      "This file is intended to be uploaded into ChatGPT, a Project, or GPT knowledge as reference material.",
      "It is not a native ChatGPT history restore file.", "", "Recommended prompt after upload:",
      "\"Use this file as prior conversation history and answer based on it. When useful, cite the conversation title and message number.\"",
      "", ...summaryLines, ""
    ].join("\n");
  }

  function formatConversationAsGptImport(conversation) {
    return (`${buildGptImportIntro([
      `- Title: ${conversation.title}`, `- Exported at: ${conversation.exportedAt}`,
      `- Source: ${conversation.url}`, `- Messages: ${conversation.messageCount}`
    ])}\n${formatConversationForGptImport(conversation, 0)}`).replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  function buildArchiveGptImportFiles(archive, baseName) {
    const files = [];
    const headerLines = [
      `- Exported at: ${archive.exportedAt}`, `- Source: ${archive.source}`,
      `- Conversations exported: ${archive.totalConversations}`, `- Conversations requested: ${archive.requestedConversations}`,
      `- Conversations failed: ${archive.failedConversations}`
    ];
    let partNumber = 1;
    let current = buildGptImportIntro(headerLines);
    archive.conversations.forEach((conversation, index) => {
      const section = formatConversationForGptImport(conversation, index);
      if (current.length + section.length > GPT_UPLOAD_TARGET_CHARS && current.length) {
        files.push({ filename: `${baseName}-gpt-import-part-${String(partNumber).padStart(2, "0")}.md`, mimeType: "text/markdown;charset=utf-8", content: `${current.trim()}\n` });
        partNumber += 1;
        current = buildGptImportIntro([...headerLines, `- File part: ${partNumber}`]);
      }
      current += section;
    });
    if (archive.failures.length) {
      current += "## Failed Conversations\n\n";
      archive.failures.forEach((failure, index) => { current += `${index + 1}. ${failure.title} (${failure.id})\n   ${failure.error}\n`; });
    }
    files.push({ filename: `${baseName}-gpt-import-part-${String(partNumber).padStart(2, "0")}.md`, mimeType: "text/markdown;charset=utf-8", content: `${current.trim()}\n` });
    return files;
  }

  function formatAllMarkdown(archive) {
    const lines = [
      "# ChatGPT Archive", "", `- Exported at: ${archive.exportedAt}`, `- Source: ${archive.source}`,
      `- Conversations: ${archive.totalConversations}`, `- Requested: ${archive.requestedConversations}`, `- Failed: ${archive.failedConversations}`, ""
    ];
    archive.conversations.forEach((conversation, index) => {
      lines.push(`## ${index + 1}. ${conversation.title}`, "", `- URL: ${conversation.url}`);
      if (conversation.createTime) lines.push(`- Created: ${conversation.createTime}`);
      if (conversation.updateTime) lines.push(`- Updated: ${conversation.updateTime}`);
      lines.push(`- Messages: ${conversation.messageCount}`, "");
      conversation.messages.forEach((message) => lines.push(`### ${message.index}. ${formatRoleLabel(message.role)}`, "", message.markdown || message.text || "", ""));
    });
    if (archive.failures.length) {
      lines.push("## Failed Conversations", "");
      archive.failures.forEach((failure, index) => lines.push(`${index + 1}. ${failure.title} (${failure.id})`, `   ${failure.error}`));
    }
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }

  function formatAllText(archive) {
    const lines = [
      "ChatGPT Archive", `Exported at: ${archive.exportedAt}`, `Source: ${archive.source}`,
      `Conversations: ${archive.totalConversations}`, `Requested: ${archive.requestedConversations}`, `Failed: ${archive.failedConversations}`, ""
    ];
    archive.conversations.forEach((conversation, index) => {
      lines.push(`[Conversation ${index + 1}] ${conversation.title}`, `URL: ${conversation.url}`, `Messages: ${conversation.messageCount}`, "");
      conversation.messages.forEach((message) => lines.push(`[${message.index}] ${formatRoleLabel(message.role)}`, message.text || message.markdown || "", ""));
    });
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

  function buildExportPayload(format, conversation) {
    if (!conversation?.messageCount) throw new Error("No conversation messages found on this page.");
    const baseName = `${slugifyTitle(conversation.title)}-${timestampForFile(conversation.exportedAt)}`;
    if (format === "json") return { content: formatJson(conversation), filename: `${baseName}.json`, mimeType: "application/json;charset=utf-8" };
    if (format === "txt") return { content: formatText(conversation), filename: `${baseName}.txt`, mimeType: "text/plain;charset=utf-8" };
    if (format === "gptbundle") return { content: formatConversationAsGptImport(conversation), filename: `${baseName}-gpt-import.md`, mimeType: "text/markdown;charset=utf-8" };
    return { content: formatMarkdown(conversation), filename: `${baseName}.md`, mimeType: "text/markdown;charset=utf-8" };
  }

  function getExportPayload(format, doc) { return buildExportPayload(format, collectConversation(doc)); }
  async function getCurrentExportPayload(format, doc) { return buildExportPayload(format, await collectCurrentConversation(doc)); }

  async function getArchiveExportPayload(format) {
    const archive = await collectAllConversations();
    const baseName = `chatgpt-archive-${timestampForFile(archive.exportedAt)}`;
    if (format === "json") return { content: formatJson(archive), filename: `${baseName}.json`, mimeType: "application/json;charset=utf-8" };
    if (format === "txt") return { content: formatAllText(archive), filename: `${baseName}.txt`, mimeType: "text/plain;charset=utf-8" };
    if (format === "gptbundle") {
      const files = buildArchiveGptImportFiles(archive, baseName);
      return { files, detail: files.length === 1 ? files[0].filename : `${files.length} GPT import files` };
    }
    return { content: formatAllMarkdown(archive), filename: `${baseName}.md`, mimeType: "text/markdown;charset=utf-8" };
  }

  global.ChatGPTExporter = {
    collectConversation,
    collectCurrentConversation,
    collectAllConversations,
    createDownload,
    extractMessagesFromApiConversation,
    fetchConversationDetail,
    fetchJson,
    formatAllMarkdown,
    formatAllText,
    formatJson,
    formatMarkdown,
    formatText,
    getArchiveExportPayload,
    getConversationIdFromLocation,
    getConversationTitle,
    getCurrentExportPayload,
    getExportPayload,
    slugifyTitle
  };
})(globalThis);
