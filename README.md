# OmniGPT

[通过 Greasy Fork 安装（推荐）](https://greasyfork.org/zh-CN/scripts/590463-omnigpt-chatgpt-export-latex-copy)

[通过 GitHub Raw 安装（备用）](https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js)

OmniGPT 是一个可直接导入 Tampermonkey（油猴）的 ChatGPT userscript，当前聚焦两件事：

- 导出当前对话或全部历史对话，支持 Markdown、JSON、TXT 和适合上传给 GPT 作为参考资料的 Markdown 导入包。
- 复制包含 KaTeX 公式的选区时保留原始 LaTeX；双击公式可单独复制；ChatGPT 的选区引用也能读取 LaTeX 文本。

## 安装

1. 安装 Tampermonkey。
2. 点击上方 Greasy Fork 安装链接，再点击页面中的“安装此脚本”。也可以使用 GitHub Raw 备用链接。
3. Tampermonkey 会打开安装页，确认安装即可。
4. 刷新 `https://chatgpt.com/`，页面右下角会出现 **OmniGPT** 按钮。

本地安装时，也可以在 Tampermonkey 中新建脚本，把 `OmniGPT.user.js` 的完整内容粘贴进去并保存。

## 使用

点击页面右下角的 **OmniGPT**：

- “当前对话”从当前页面 DOM 导出，适合正在查看的聊天。
- “全部对话”通过当前登录会话读取 ChatGPT 历史接口；记录多时需要等待。
- “复制 Markdown”不会下载文件，直接写入剪贴板。
- “GPT 导入包”是便于重新上传给 ChatGPT、Project 或 GPT knowledge 的参考材料，不是原生聊天记录恢复文件。

公式功能无需打开面板：

- 正常框选一段包含公式的回复并复制，剪贴板中的公式会变为 `$...$` 或 `$$...$$`。
- 双击单个公式，直接复制对应 LaTeX。

## 本地开发

需要 Node.js 20 或更高版本，无第三方运行时依赖。

```bash
npm run build
npm run check
```

源码位于：

- `src/exporter.js`：对话采集、格式化、下载和历史接口读取。
- `src/omnigpt.js`：油猴页面入口、导出面板和 LaTeX 复制。
- `scripts/build.mjs`：生成可安装的 `OmniGPT.user.js`。

请勿直接只修改生成文件；修改 `src/` 后重新执行构建。

## 隐私与兼容性

OmniGPT 不包含分析、遥测或第三方上传逻辑。导出在浏览器本地完成；“全部对话”只向当前 ChatGPT 站点发送请求，并使用已有登录状态。

ChatGPT 的页面 DOM 和未公开历史接口可能变化。如果导出失败，请先刷新页面并确认当前已登录，再提交 issue，并附上浏览器版本、复现步骤和控制台中的 `[OmniGPT]` 错误（请先移除私人内容和令牌）。

## 来源与许可

导出逻辑基于同目录下先前的 `chatgpt-exporter` 项目整理。LaTeX 兼容思路来自 ChatGPT Better TeX Quote（schweigen，MIT）与 TexCopyer（yjy / blime，GPL-3.0）；详见 `THIRD_PARTY_NOTICES.md`。

本项目以 [GPL-3.0-or-later](https://www.gnu.org/licenses/gpl-3.0.html) 发布。
