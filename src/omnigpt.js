(function initOmniGPT(global) {
  "use strict";
  if (global.__omniGPTInjected || !global.OmniGPTClipboard) return;
  global.__omniGPTInjected = true;

  const ROOT_ID = "omnigpt-root";
  const clipboard = global.OmniGPTClipboard;
  let statusTimer = null;
  let statusNode = null;

  function showToast(message) {
    if (!document.body) return;
    const toast = element("div", "omnigpt-toast", message);
    document.body.appendChild(toast);
    global.setTimeout(() => toast.remove(), 1400);
  }

  // Register copy capture before ChatGPT installs its own handlers. No DOM scan occurs here.
  clipboard.install(showToast);

  function injectStyles() {
    if (document.getElementById("omnigpt-style")) return;
    const style = document.createElement("style");
    style.id = "omnigpt-style";
    style.textContent = `
      #${ROOT_ID}{position:fixed;right:18px;bottom:18px;z-index:2147483000;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#e7e7e7}
      #${ROOT_ID} *{box-sizing:border-box}
      .omnigpt-launcher{display:flex;align-items:center;justify-content:center;gap:8px;border:1px solid #484848;border-radius:999px;background:#111;color:#fff;padding:10px 16px;font-weight:700;box-shadow:0 10px 30px #0004;cursor:pointer}
      .omnigpt-launcher:hover{background:#1b1b1b}.omnigpt-launcher:focus-visible{outline:2px solid #8ee3ad;outline-offset:3px}
      .omnigpt-mark{display:none;font-size:15px;font-weight:800;line-height:1}
      .omnigpt-panel{position:absolute;right:0;bottom:48px;width:290px;padding:14px;border:1px solid #3a3a3a;border-radius:16px;background:#141414;box-shadow:0 18px 50px #0005}
      .omnigpt-panel[hidden]{display:none}.omnigpt-title{font-size:15px;font-weight:750;margin:0 0 2px}
      .omnigpt-hint{font-size:11px;color:#aaa;margin-bottom:12px;line-height:1.5}
      .omnigpt-section{font-size:11px;color:#aaa;margin:12px 0 6px;text-transform:uppercase;letter-spacing:.08em}
      .omnigpt-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
      .omnigpt-action{border:1px solid #3a3a3a;border-radius:9px;background:#262626;color:#f3f3f3;padding:8px 7px;font-size:12px;cursor:pointer}
      .omnigpt-action:hover{background:#343434;border-color:#555}.omnigpt-action:disabled{cursor:wait;opacity:.5}
      .omnigpt-status{min-height:18px;margin-top:10px;font-size:11px;color:#9bd1a8;line-height:1.5;overflow-wrap:anywhere}
      .omnigpt-status[data-error="true"]{color:#ff9b9b}.omnigpt-setting{display:flex;align-items:center;gap:8px;font-size:12px;margin-top:12px}
      .omnigpt-toast{position:fixed;left:50%;bottom:10%;z-index:2147483647;transform:translateX(-50%);padding:9px 15px;border-radius:999px;background:#111;color:#fff;font:12px ui-sans-serif,system-ui}
      @media (max-width:1100px){#${ROOT_ID}{right:10px;top:50%;bottom:auto;transform:translateY(-50%)}.omnigpt-launcher{width:40px;height:40px;padding:0}.omnigpt-mark{display:block}.omnigpt-label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.omnigpt-panel{right:50px;top:50%;bottom:auto;transform:translateY(-50%);max-height:calc(100vh - 24px);overflow:auto}}
      @media (max-width:370px){.omnigpt-panel{width:calc(100vw - 70px)}}
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
    panel.append(element("div", "omnigpt-title", "导出 ChatGPT 对话"), element("div", "omnigpt-hint", "含公式选区复制为纯文本 Markdown；双击复制单个公式。"));
    for (const scope of ["current", "all"]) {
      panel.appendChild(element("div", "omnigpt-section", scope === "current" ? "当前对话" : "全部对话"));
      const grid = element("div", "omnigpt-grid");
      grid.dataset[scope] = "";
      [["Markdown", "markdown"], ["JSON", "json"], ["TXT", "txt"], ["GPT 导入包", "gptbundle"]]
        .forEach(([label, format]) => grid.appendChild(createButton(label, { format, scope })));
      if (scope === "current") grid.appendChild(createButton("复制 Markdown", { copy: "markdown" }));
      panel.appendChild(grid);
    }
    const setting = element("label", "omnigpt-setting");
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.checked = clipboard.quoteCompatibility;
    checkbox.addEventListener("change", () => {
      clipboard.setQuoteCompatibility(checkbox.checked);
      checkbox.checked = clipboard.quoteCompatibility;
      setStatus(checkbox.checked ? "引用兼容已开启；选区转文本时按需处理公式" : "轻量模式：不改写浏览器选区方法");
    });
    setting.append(checkbox, document.createTextNode("引用兼容（默认关闭）"));
    panel.append(setting, element("div", "omnigpt-hint", "仅需要原生选区引用保留 TeX 时开启。框选复制、双击复制无需开启。"));
    statusNode = element("div", "omnigpt-status");
    statusNode.setAttribute("aria-live", "polite");
    panel.appendChild(statusNode);
    root.append(launcher, panel);
    return { root, launcher, panel };
  }

  function setStatus(message, isError = false) {
    if (!statusNode) return;
    statusNode.textContent = message;
    statusNode.dataset.error = String(isError);
    global.clearTimeout(statusTimer);
    // Keep errors visible until the next action rather than hiding useful diagnostics after 4 seconds.
    if (!isError) statusTimer = global.setTimeout(() => { statusNode.textContent = ""; delete statusNode.dataset.error; }, 6000);
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

  function setupUi() {
    if (document.getElementById(ROOT_ID) || !global.ChatGPTExporter) return;
    injectStyles();
    const { root, launcher, panel } = createUiTree();
    const actions = root.querySelectorAll(".omnigpt-action");
    document.body.appendChild(root);
    launcher.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      launcher.setAttribute("aria-expanded", String(!panel.hidden));
    });
    root.addEventListener("click", async (event) => {
      const button = event.target.closest?.("button[data-format], button[data-copy]");
      if (!button || button.disabled) return;
      actions.forEach((item) => { item.disabled = true; });
      try {
        if (button.dataset.copy) {
          setStatus("正在读取当前对话…");
          const payload = await currentPayload("markdown");
          await clipboard.writeText(payload.content);
          setStatus("Markdown 已复制（纯文本）");
        } else {
          const isArchive = button.dataset.scope === "all";
          setStatus(isArchive ? "正在读取全部历史对话…" : "正在导出当前对话…");
          const payload = isArchive ? await global.ChatGPTExporter.getArchiveExportPayload(button.dataset.format) : await currentPayload(button.dataset.format);
          setStatus(`完成：${downloadPayload(payload)}`);
        }
      } catch (error) {
        console.error("[OmniGPT] Export failed.", error);
        setStatus(error?.message || "导出失败", true);
      } finally { actions.forEach((item) => { item.disabled = false; }); }
    });
    document.addEventListener("click", (event) => {
      if (!panel.hidden && !root.contains(event.target)) {
        panel.hidden = true;
        launcher.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) {
        panel.hidden = true;
        launcher.setAttribute("aria-expanded", "false");
        launcher.focus();
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setupUi, { once: true });
  else setupUi();
})(globalThis);
