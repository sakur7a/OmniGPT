import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/exporter.js", import.meta.url), "utf8");
function load(fetch) {
  const context = { console, Date, Blob, URL, AbortController, setTimeout, clearTimeout, fetch,
    location: { origin: "https://chatgpt.com", pathname: "/c/test-id", href: "https://chatgpt.com/c/test-id" } };
  runInNewContext(source, context);
  return { exporter: context.ChatGPTExporter, context };
}
const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const msg = (id, role, text, more = {}) => ({ id, author: { role }, content: { parts: [text] }, ...more });
const page = (messages, hasPrevious, cursor = "cursor-0") => ({
  conversation_id: "test-id", title: "Test", current_node: "a3", messages,
  page_info: { has_previous_page: hasPrevious, has_next_page: false, start_cursor: cursor }
});
const auth = handler => async (url, init) => String(url).endsWith("/api/auth/session")
  ? reply(200, { accessToken: "token" }) : handler(new URL(url), init);
const json = value => JSON.parse(JSON.stringify(value));

test("plural endpoint returns one complete flat page without probing legacy route", async () => {
  const calls = [];
  const p = page([msg("u3", "user", "question"), msg("a3", "assistant", "answer")], false);
  const { exporter } = load(auth(url => { calls.push(url); return reply(200, p); }));
  const c = await exporter.collectCurrentConversation({ title: "Page title" });
  assert.equal(c.acquisition, "api");
  assert.equal(c.partial, false);
  assert.deepEqual(json(c.messages).map(m => m.text), ["question", "answer"]);
  assert.equal(c.id, "test-id");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, "/backend-api/conversations/test-id");
  assert.equal(calls[0].searchParams.get("num_turns"), "100");
  assert.equal(calls[0].searchParams.get("include_has_versions"), "true");
});

test("older pages use before cursor and preserve chronological order without duplicate boundary messages", async () => {
  const paths = [];
  const newest = page([msg("u3", "user", "  Q3"), msg("a3", "assistant", "A3\n\n  ")], true, "middle");
  const oldest = page([msg("u1", "user", "Q1"), msg("a1", "assistant", "A1"),
    msg("u2", "user", "Q2"), msg("a2", "assistant", "A2"),
    msg("u3", "user", "stale Q3")], false, "start");
  const { exporter } = load(auth(url => {
    paths.push(url.pathname + url.search);
    return reply(200, url.searchParams.has("before") ? oldest : newest);
  }));
  const result = await exporter.collectCurrentConversation({ title: "DOM" });
  assert.deepEqual(json(result.messages).map(x => x.text), ["Q1", "A1", "Q2", "A2", "  Q3", "A3\n\n  "]);
  assert.deepEqual(json(result.messages).map(x => x.index), [1, 2, 3, 4, 5, 6]);
  assert.ok(paths[1].includes("before=middle"));
  assert.equal(result.partial, false);
  assert.ok(exporter.formatMarkdown(result).includes("A3\n\n  "));
});

test("flat wrapped messages with parent links follow current_node rather than exporting alternative answers", () => {
  const { exporter } = load();
  const detail = {
    current_node: "a3",
    messages: [
      { id: "u", parent: null, message: msg("u", "user", "question") },
      { id: "alt", parent: "u", message: msg("alt", "assistant", "wrong branch") },
      { id: "hidden", parent: "u", message: msg("hidden", "assistant", "secret", { metadata: { channel: "analysis" } }) },
      { id: "a3", parent: "hidden", message: msg("a3", "assistant", "right branch") }
    ]
  };
  assert.deepEqual(json(exporter.extractMessagesFromApiConversation(detail)).map(x => x.text), ["question", "right branch"]);
});

test("hidden reasoning content types and commentary are not exported", () => {
  const { exporter } = load();
  const detail = { current_node: "a", messages: [
    msg("u", "user", "question"),
    msg("h", "assistant", "private reasoning", { content: { content_type: "thoughts", text: "private reasoning" } }),
    msg("c", "assistant", "tool commentary", { metadata: { channel: "commentary" } }),
    msg("a", "assistant", "answer")
  ] };
  assert.deepEqual(json(exporter.extractMessagesFromApiConversation(detail)).map(x => x.text), ["question", "answer"]);
});

test("legacy mapping endpoint remains a fallback only after new route returns 404", async () => {
  const calls = [];
  const { exporter } = load(auth(url => {
    calls.push(url.pathname);
    if (url.pathname === "/backend-api/conversations/test-id") return reply(404, {});
    if (url.pathname === "/backend-api/conversation/test-id") return reply(200, {
      conversation_id: "test-id", current_node: "a", mapping: {
        u: { parent: null, message: msg("u", "user", "Q") },
        a: { parent: "u", message: msg("a", "assistant", "A") }
      }
    });
    return reply(500, {});
  }));
  const c = await exporter.collectCurrentConversation({ title: "DOM" });
  assert.deepEqual(json(c.messages).map(m => m.text), ["Q", "A"]);
  assert.equal(c.partial, false);
  assert.ok(calls.every((path) => ["/backend-api/conversations/test-id", "/backend-api/conversation/test-id"].includes(path)));
  assert.equal(calls.at(-1), "/backend-api/conversation/test-id");
});

test("200 with missing or unknown page markers fails closed, not treated as a complete conversation", async () => {
  const { exporter } = load(auth(() => reply(200, { messages: [msg("a3", "assistant", "A")], current_node: "a3" })));
  await assert.rejects(exporter.fetchConversationDetail("test-id"), err => err.code === "SCHEMA");
});

test("bad cursor, repeated cursor and empty follow-up page fail without returning partial content", async () => {
  const newest = page([msg("a3", "assistant", "A")], true, "");
  const missing = load(auth(() => reply(200, newest)));
  await assert.rejects(missing.exporter.fetchConversationDetail("test-id"), err => err.code === "PAGINATION");
  const repeated = load(auth(url => reply(200, url.searchParams.has("before")
    ? page([msg("a2", "assistant", "B")], true, "repeat")
    : page([msg("a3", "assistant", "A")], true, "repeat"))));
  await assert.rejects(repeated.exporter.fetchConversationDetail("test-id"), err => err.code === "PAGINATION");
  const empty = load(auth(url => reply(200, url.searchParams.has("before")
    ? page([], false) : page([msg("a3", "assistant", "A")], true, "cursor"))));
  await assert.rejects(empty.exporter.fetchConversationDetail("test-id"), err => err.code === "PAGINATION");
});

test("incorrect conversation ID and missing current_node fail rather than export the wrong chat", async () => {
  const mismatch = load(auth(() => reply(200, { ...page([msg("a3", "assistant", "A")], false), conversation_id: "other" })));
  await assert.rejects(mismatch.exporter.fetchConversationDetail("test-id"), err => err.code === "SCHEMA");
  const missing = load(auth(() => reply(200, page([msg("a2", "assistant", "A")], false))));
  await assert.rejects(missing.exporter.collectCurrentConversation({}), err => err.code === "BRANCH");
});

test("uncompleted generation rejects a flat export instead of writing a misleading file", async () => {
  const { exporter } = load(auth(() => reply(200, page([
    msg("u", "user", "question"), msg("a3", "assistant", "unfinished", { status: "in_progress" })
  ], false))));
  await assert.rejects(exporter.fetchConversationDetail("test-id").then(d => exporter.extractMessagesFromApiConversation(d)),
    err => err.code === "IN_PROGRESS");
});

test("pagination abort cancels in-flight request instead of silently using DOM content", async () => {
  const controller = new AbortController();
  let pageCalls = 0;
  const { exporter } = load(auth((url, init) => {
    if (!url.searchParams.has("before")) return reply(200, page([msg("a3", "assistant", "A")], true, "older"));
    pageCalls++;
    return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(Error("aborted"))));
  }));
  const p = exporter.collectCurrentConversation({}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(p, err => err.name === "AbortError");
  assert.equal(pageCalls, 1);
});
