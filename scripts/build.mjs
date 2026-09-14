import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const sources = await Promise.all(["clipboard.js", "exporter.js", "omnigpt.js"].map((file) =>
  readFile(path.join(projectRoot, "src", file), "utf8")));
const metadata = `// ==UserScript==
// @name         OmniGPT - ChatGPT Export & LaTeX Copy
// @name:zh-CN   OmniGPT - ChatGPT 对话导出与 LaTeX 复制
// @namespace    https://github.com/sakur7a/OmniGPT
// @version      ${version}
// @description  Export conversations and copy LaTeX as portable plain-text Markdown. Optional quote compatibility.
// @description:zh-CN 导出对话，复制为保留 LaTeX 的纯文本 Markdown；可选引用兼容。
// @author       OmniGPT contributors
// @license      GPL-3.0-or-later
// @homepageURL  https://github.com/sakur7a/OmniGPT
// @supportURL   https://github.com/sakur7a/OmniGPT/issues
// @downloadURL  https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js
// @updateURL    https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==`;
const output = `${metadata}\n\n${sources.map((source) => source.trim()).join("\n\n")}\n`;
await writeFile(path.join(projectRoot, "OmniGPT.user.js"), output, "utf8");
console.log(`Built OmniGPT.user.js (${Buffer.byteLength(output)} bytes)`);
