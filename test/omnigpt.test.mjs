import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const exporterSource = await readFile(new URL("../src/exporter.js", import.meta.url), "utf8");
const omnigptSource = await readFile(new URL("../src/omnigpt.js", import.meta.url), "utf8");
const userscriptSource = await readFile(new URL("../OmniGPT.user.js", import.meta.url), "utf8");

function loadExporter(overrides = {}) {
  const context = {
    console,
    Date,
    Blob,
    URL,
    setTimeout,
    clearTimeout,
    location: { origin: "https://chatgpt.com", href: "https://chatgpt.com/c/test-id", pathname: "/c/test-id" },
    ...overrides
  };
  context.globalThis = context;
  runInNewContext(exporterSource, context);
  return { exporter: context.ChatGPTExporter, context };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async json() { return body; },
    async text() { return typeof body === "string" ? body : JSON.stringify(body); }
  };
}

test("generated userscript has v0.2.0 installable metadata", () => {
  assert.match(userscriptSource, /^\/\/ ==UserScript==/);
  assert.match(userscriptSource, /\/\/ @version\s+0\.2\.0/);
  assert.match(userscriptSource, /\/\/ @grant\s+none/);
  assert.match(userscriptSource, /https:\/\/chatgpt\.com\/\*/);
});

test("export formatters keep markdown and metadata", () => {
  const { exporter } = loadExporter();
  const conversation = {
    title: "公式测试",
    exportedAt: "2026-08-09T00:00:00.000Z",
    url: "https://chatgpt.com/c/test",
    messageCount: 1,
    messages: [{ index: 1, role: "assistant", text: "x squared", markdown: "$x^2$" }]
  };
  assert.match(exporter.formatMarkdown(conversation), /\$x\^2\$/);
  assert.equal(exporter.slugifyTitle("  Omni GPT / 测试  "), "omni-gpt-测试");
  assert.equal(JSON.parse(exporter.formatJson(conversation)).messageCount, 1);
});

test("current conversation prefers API mapping and extracts active branch", async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/auth/session")) return jsonResponse(200, { accessToken: "token" });
    if (String(url).includes("/backend-api/conversation/test-id")) return jsonResponse(200, {
      id: "test-id",
      title: "API title",
      current_node: "a2",
      mapping: {
        u1: { parent: null, message: { author: { role: "user" }, content: { parts: ["hello"] }, create_time: 1 } },
        a2: { parent: "u1", message: { author: { role: "assistant" }, content: { parts: ["world"] }, create_time: 2 } }
      }
    });
    return jsonResponse(404, "not found");
  };
  const { exporter } = loadExporter({ fetch });
  const conversation = await exporter.collectCurrentConversation({ title: "DOM title" });
  assert.equal(conversation.title, "API title");
  assert.deepEqual(Array.from(conversation.messages, (message) => message.text), ["hello", "world"]);
  assert.ok(calls.some((url) => url.includes("/backend-api/conversation/test-id")));
});

test("404 on authenticated backend request refreshes token once", async () => {
  const authHeaders = [];
  let sessionCount = 0;
  let detailCount = 0;
  const fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/api/auth/session")) {
      sessionCount += 1;
      return jsonResponse(200, { accessToken: sessionCount === 1 ? "stale" : "fresh" });
    }
    if (value.includes("/backend-api/conversation/abc")) {
      detailCount += 1;
      authHeaders.push(init.headers?.authorization || "");
      return detailCount === 1 ? jsonResponse(404, "masked auth failure") : jsonResponse(200, { current_node: null, mapping: {} });
    }
    return jsonResponse(404, "not found");
  };
  const { exporter } = loadExporter({ fetch });
  await exporter.fetchConversationDetail("abc");
  assert.deepEqual(authHeaders, ["Bearer stale", "Bearer fresh"]);
  assert.equal(sessionCount, 2);
});

test("compatibility selectors include data-turn and newer math containers", () => {
  assert.match(exporterSource, /section\[data-turn='user'\]/);
  assert.match(exporterSource, /section\[data-turn='assistant'\]/);
  assert.match(omnigptSource, /mjx-container/);
  assert.match(omnigptSource, /data-math-source/);
  assert.match(omnigptSource, /data-latex/);
  assert.match(omnigptSource, /\bmath\b/);
});

test("UI construction is Trusted Types safe", () => {
  assert.doesNotMatch(omnigptSource, /\.innerHTML\s*=/);
  assert.doesNotMatch(omnigptSource, /DOMParser/);
  assert.match(omnigptSource, /document\.createElement/);
});

test("formula support still patches copy and quote serialization", () => {
  assert.match(userscriptSource, /addEventListener\("copy"/);
  assert.match(userscriptSource, /function omniGPTSelectionToString\(/);
  assert.match(userscriptSource, /function transformMath\(/);
});

test("narrow layouts still dock the launcher beside the conversation", () => {
  assert.match(userscriptSource, /@media \(max-width:1100px\)/);
  assert.match(userscriptSource, /top:50%;bottom:auto;transform:translateY\(-50%\)/);
  assert.match(userscriptSource, /omnigpt-mark/);
});
