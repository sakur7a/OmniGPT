import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.env.npm_package_version || "0.1.0";
const [exporter, omnigpt] = await Promise.all([
  readFile(path.join(projectRoot, "src", "exporter.js"), "utf8"),
  readFile(path.join(projectRoot, "src", "omnigpt.js"), "utf8")
]);

const metadata = `// ==UserScript==
// @name         OmniGPT
// @namespace    https://github.com/sakur7a/OmniGPT
// @version      ${version}
// @description  导出 ChatGPT 对话，并在复制或引用时保留原始 LaTeX 公式。
// @author       OmniGPT contributors
// @license      GPL-3.0-or-later
// @homepageURL  https://github.com/sakur7a/OmniGPT
// @supportURL   https://github.com/sakur7a/OmniGPT/issues
// @downloadURL  https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js
// @updateURL    https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==`;

const output = `${metadata}\n\n${exporter.trim()}\n\n${omnigpt.trim()}\n`;
await writeFile(path.join(projectRoot, "OmniGPT.user.js"), output, "utf8");
console.log(`Built OmniGPT.user.js (${Buffer.byteLength(output)} bytes)`);
