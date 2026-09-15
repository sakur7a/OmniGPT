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
