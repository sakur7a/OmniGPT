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
