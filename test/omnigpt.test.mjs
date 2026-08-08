import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const exporterSource = await readFile(new URL("../src/exporter.js", import.meta.url), "utf8");
const userscriptSource = await readFile(new URL("../OmniGPT.user.js", import.meta.url), "utf8");

function loadExporter() {
  const context = {
    console,
    Date,
    Blob,
    URL,
    setTimeout,
    clearTimeout,
    location: { origin: "https://chatgpt.com", href: "https://chatgpt.com/c/test" }
  };
  context.globalThis = context;
  runInNewContext(exporterSource, context);
  return context.ChatGPTExporter;
}

test("generated userscript has installable metadata", () => {
  assert.match(userscriptSource, /^\/\/ ==UserScript==/);
  assert.match(userscriptSource, /\/\/ @name\s+OmniGPT - ChatGPT Export & LaTeX Copy/);
  assert.match(userscriptSource, /\/\/ @name:zh-CN\s+OmniGPT - ChatGPT 对话导出与 LaTeX 复制/);
  assert.match(userscriptSource, /\/\/ @grant\s+none/);
  assert.match(userscriptSource, /https:\/\/chatgpt\.com\/\*/);
});

test("export formatters keep markdown and metadata", () => {
  const exporter = loadExporter();
  const conversation = {
    title: "公式测试",
    exportedAt: "2026-08-09T00:00:00.000Z",
    url: "https://chatgpt.com/c/test",
    messageCount: 1,
    messages: [{ index: 1, role: "assistant", text: "x squared", markdown: "$x^2$" }]
  };

  const markdown = exporter.formatMarkdown(conversation);
  assert.match(markdown, /# 公式测试/);
  assert.match(markdown, /\$x\^2\$/);
  assert.equal(exporter.slugifyTitle("  Omni GPT / 测试  "), "omni-gpt-测试");
  assert.equal(JSON.parse(exporter.formatJson(conversation)).messageCount, 1);
});

test("built output does not contain known mojibake from the legacy script", () => {
  assert.doesNotMatch(userscriptSource, /鏁村悎|宸插鍒|璇濋/);
});

test("formula support covers export, clipboard copy, and quote serialization", () => {
  assert.match(exporterSource, /function renderKatex\(/);
  assert.match(userscriptSource, /addEventListener\("copy"/);
  assert.match(userscriptSource, /function omniGPTSelectionToString\(/);
});
