import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/exporter.js", import.meta.url), "utf8");
const reply = (status, body, extra = {}) => ({ ok: status === 200, status, json: async () => body, ...extra });
function load(fetch) {
  const context = { console, Date, Blob, URL, AbortController, setTimeout, clearTimeout, fetch,
    location: { origin: "https://chatgpt.com", pathname: "/c/test-id", href: "https://chatgpt.com/c/test-id" } };
  runInNewContext(source, context);
  return context.ChatGPTExporter;
}
const auth = fn => async url => String(url).endsWith("/api/auth/session")
  ? reply(200, { accessToken: "test-token" }) : fn(new URL(url));

test("empty export reports an English message without changing its error code", () => {
  const exporter = load();
  assert.throws(() => exporter.buildExportPayload("markdown", { messageCount: 0 }),
    error => error.code === "EMPTY" && error.message === "No exportable content found");
});

test("HTTP messages are English and retain the original HTTP status and error code", async () => {
  const messages = new Map([
    [401, "Your session has expired. Refresh the page and try again"],
    [403, "Access denied or request blocked"],
    [404, "Endpoint or conversation unavailable"],
    [429, "Too many requests. Please try again later"],
    [500, "Request failed"]
  ]);
  for (const [status, message] of messages) {
    const exporter = load(async () => reply(status, {}, { headers: { get: () => "120" } }));
    await assert.rejects(exporter.fetchJson("/backend-api/conversations"),
      error => error.code === "HTTP" && error.status === status && error.message === `${message} (HTTP ${status})`);
  }
});

test("transport, schema and cancellation messages stay sanitized and keep their identifiers", async () => {
  const offline = load(async () => { throw Error("private-token 私密信息"); });
  await assert.rejects(offline.fetchJson("/backend-api/conversations"),
    error => error.code === "NETWORK" && error.message === "Network request failed. Check your connection and try again");
  const invalidJson = load(async () => reply(200, null, { json: async () => { throw SyntaxError("private response"); } }));
  await assert.rejects(invalidJson.fetchJson("/backend-api/conversations"),
    error => error.code === "SCHEMA" && error.message === "The response is not valid JSON. You may need to sign in again");
  await assert.rejects(offline.fetchConversationDetail(""),
    error => error.code === "SCHEMA" && error.message === "Conversation ID is missing");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(offline.fetchJson("/backend-api/conversations", { signal: controller.signal }),
    error => error.name === "AbortError" && error.message === "Export cancelled");
});

test("incomplete pagination retains its fail-closed behavior with an English explanation", async () => {
  const exporter = load(auth(() => reply(200, { conversation_id: "test-id", messages: [] })));
  await assert.rejects(exporter.fetchConversationDetail("test-id"),
    error => error.code === "SCHEMA" && error.message === "Export stopped: incomplete conversation pagination data");
  const badCursor = load(auth(() => reply(200, { conversation_id: "test-id", messages: [],
    page_info: { has_previous_page: true, has_next_page: false, start_cursor: "" } })));
  await assert.rejects(badCursor.fetchConversationDetail("test-id"),
    error => error.code === "PAGINATION" && error.message === "Export stopped: a conversation pagination cursor is missing or repeated");
});

test("English warnings and placeholders preserve Chinese conversation content and attachment names", async () => {
  const text = "这段中文保持原样。\n\n```text\n中文代码内容\n```";
  const detail = { id: "test-id", title: "中文标题", mapping: {
    u: { parent: null, message: { author: { role: "user" }, content: { parts: ["用户问题"] } } },
    a: { parent: "u", message: { author: { role: "assistant" }, content: { parts: [text, { name: "图像.png" }] } } }
  } };
  const exporter = load(auth(() => reply(200, detail)));
  const conversation = await exporter.collectCurrentConversation({});
  assert.ok(conversation.messages[1].text.startsWith(text));
  assert.ok(conversation.messages[1].text.includes("[Attachment/non-text content: 图像.png]"));
  assert.equal(conversation.warnings.length, 2);
  assert.ok(conversation.warnings.every(warning => !/[\u4e00-\u9fff]/u.test(warning)));
  for (const output of [exporter.formatMarkdown(conversation), exporter.formatText(conversation), exporter.formatJson(conversation)]) {
    for (const original of ["中文标题", "用户问题", "这段中文保持原样。", "中文代码内容", "图像.png"]) assert.ok(output.includes(original));
  }
  assert.ok(exporter.formatMarkdown(conversation).includes("> Warning: "));
});

test("reference bundle annotations are English while an oversized Chinese message stays intact", () => {
  const exporter = load();
  const text = "完整中文正文\n\n```text\n保留缩进与代码\n```";
  const archive = { warnings: ["Synthetic warning"], failures: [], conversations: [
    { title: "中文标题", messages: [{ index: 1, role: "assistant", text }] }
  ] };
  const files = exporter.buildArchiveGptImportFiles(archive, "example", { bundleTargetChars: 40 });
  assert.equal(files.length, 1);
  assert.ok(files[0].content.includes("Reference material, not a native chat history restore file."));
  assert.ok(files[0].content.includes("> This message exceeds the target chunk size and has been kept intact."));
  assert.ok(files[0].content.includes(text));
});

test("an entirely failed history export explains the failure in English instead of returning an empty archive", async () => {
  const exporter = load(auth(url => reply(200, url.searchParams.has("offset") ? { items: [{ id: "test-id" }] } : {})));
  await assert.rejects(exporter.collectAllConversations(), error => error.code === "EMPTY" &&
    error.message.startsWith("No conversations could be loaded (1 failed); no empty archive was generated.") &&
    !/[\u4e00-\u9fff]/u.test(error.message));
});
