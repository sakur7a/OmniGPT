<p align="right"><strong>简体中文</strong> · <a href="README.md">English</a></p>

<div align="center">

<h1>OmniGPT</h1>

<p><strong>让对话可归档，让公式可编辑。</strong></p>
<p>在 Tampermonkey 等用户脚本管理器中运行的轻量脚本，用于导出 ChatGPT 对话和复制可编辑的 LaTeX。</p>

<p>
  <a href="https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js"><strong>安装脚本</strong></a>
  &nbsp; · &nbsp;
  <a href="https://greasyfork.org/zh-CN/scripts/590463-omnigpt-chatgpt-export-latex-copy">Greasy Fork</a>
  &nbsp; · &nbsp;
  <a href="#开始使用">使用指南</a>
  &nbsp; · &nbsp;
  <a href="https://github.com/sakur7a/OmniGPT/releases">版本记录</a>
</p>

<p>
  <a href="https://github.com/sakur7a/OmniGPT/releases/latest"><img src="https://img.shields.io/github/v/release/sakur7a/OmniGPT?style=flat-square&label=release&color=59636e" alt="最新 GitHub Release"></a>
  <a href="https://github.com/sakur7a/OmniGPT/actions/workflows/build-userscript.yml"><img src="https://img.shields.io/github/actions/workflow/status/sakur7a/OmniGPT/build-userscript.yml?branch=main&style=flat-square&label=checks" alt="主分支构建与测试状态"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-59636e?style=flat-square" alt="MIT License"></a>
</p>

</div>

<p align="center">
  <img src="docs/assets/readme-preview.webp" width="820" alt="OmniGPT 0.3.4 实际用户脚本在隔离本地示例页中的浅色与深色面板截图">
</p>
<p align="center"><sub>v0.3.4 实际用户脚本 UI · 隔离本地示例页 · 不是已登录 ChatGPT 的截图</sub></p>

**对话归档** — 将当前对话或可访问的历史导出为 Markdown、JSON、TXT 或参考材料分片。<br>
**公式复制** — 框选复制或使用已识别的回复复制按钮，保留行内、独立公式的 TeX，也处理公式与代码混排的回复。<br>
**按需运行** — 复制时处理公式，导出时才读取数据，首次打开才创建完整面板。

本文对应 **v0.3.4**，当前页面复制兼容修复见 [0.3.4 说明](docs/V0.3.4.md)。OmniGPT 是**用户脚本**，不是独立浏览器扩展；需要先安装 Tampermonkey 等脚本管理器扩展。

## 开始使用

### 安装

1. 在浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)。主要适配目标是 Chrome / Edge 与 Tampermonkey。
2. 打开 **[GitHub Raw 安装地址](https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js)**，在管理器中确认安装。也可使用 [Greasy Fork](https://greasyfork.org/zh-CN/scripts/590463-omnigpt-chatgpt-export-latex-copy)，以该站实际发布的版本为准。
3. 确认 OmniGPT 已启用，再刷新 [chatgpt.com](https://chatgpt.com/) 上已有的对话。脚本也匹配旧版 `chat.openai.com` 域名。
4. 点击右下角 **OmniGPT** 打开面板；窄窗口时入口收拢为右侧 **O**。面板标题旁显示当前页面加载的脚本版本。

面板目前使用中文标签。请只保留一份启用的 OmniGPT，避免多份复制处理逻辑互相影响。

### 更新已有安装

1. 打开油猴管理面板，找到 **OmniGPT**，对这条脚本执行**检查更新**；具体名称和位置随管理器版本、语言而异。
2. 确认可用更新，并查看已安装版本。自动检查由管理器调度，GitHub 推送后不会保证立即更新本机脚本。
3. **刷新接下来要使用的每个 ChatGPT 标签页**，重新打开面板核对加载版本，再复制一次内容。

本仓库生成脚本的 `@updateURL` 与 `@downloadURL` 都指向上方 GitHub Raw 地址。仍应以管理器实际记录的更新源为准：若安装项使用 Greasy Fork 更新源，就需要该站先发布对应版本。**GitHub Release 与 Greasy Fork 不一定同步更新。** 未检测到更新时，可通过同一 GitHub 安装地址更新现有安装，确认版本后重试。维护者的同步配置见 [RELEASING.md](docs/RELEASING.md)。

## 复制公式与代码

| 操作 | 范围与结果 |
| :--- | :--- |
| 框选回复后 `Ctrl+C` / `⌘C` | 复制选区，保留可恢复的公式和基础 Markdown 结构；只选中渲染公式的一部分时，也会恢复该公式的完整 TeX |
| 点击 ChatGPT 回复下方的**复制按钮** | 对已识别且含支持公式的回复操作，按所选公式格式复制该条回复的助手正文块 |
| 双击渲染公式 | 复制完整公式，保留行内或独立显示形式 |
| `Alt` / `Option` ＋双击公式 | 只复制 TeX 源码，不附加定界符 |
| 面板中的**复制 Markdown** | 将当前对话复制为 Markdown；仅在**当前对话**范围可用 |

框选复制与已识别的回复复制按钮，均处理渲染公式及正文中的原始 `\(...\)` / `\[...\]` 公式。行内代码、代码块和转义后的字面定界符受到保护。不含支持公式的普通选区、编辑器和输入框选区、代码复制按钮、未识别的回复操作保留原生行为。整段含公式的选区还会将标题、列表、链接、代码和基础表格等结构序列化为 Markdown。

### 选择公式格式

在 **更多选项 → 公式复制** 中选择：

| 设置 | 行内公式 | 独立公式 |
| :--- | :--- | :--- |
| **Markdown**，默认 | `$x_i$` | TeX 前后分别独占一行的 `$$` |
| **LaTeX** | `\(x_i\)` | TeX 前后的 `\[` 与 `\]` |

例如，Markdown 复制结果为：

```markdown
不等式为 $5\leq6\leq7$，均值为：

$$
\bar{x} = \frac{1}{n} \sum_{k=1}^{n} x_k
$$

代码示例 `\(literal\)` 仍保持为代码。
```

公式格式会跨刷新保存。若之前选过 **LaTeX**，出现 `\(...\)` 可能就是预期格式。面板中的**复制 Markdown** 始终将可识别的数学定界符转换为 Markdown，不受该选项影响。通过 API 下载的文件保留原始正文已有的定界符；页面采集导出使用 Markdown 序列化。

`G_k` 与 `G\_k` 保持原义，不擅自互换。渲染器未提供可靠 TeX 源码时，不会用公式朗读标签猜测源码。可选的**引用兼容**默认关闭，仅在需要增强 ChatGPT 选区引用时开启；上述两种复制入口不需要开启它。详见 [复制机制说明](docs/CLIPBOARD.md)。

## 导出对话

1. 打开面板，选择**导出范围**：当前对话或历史对话。
2. 选择**文件格式**，按需调整**更多选项**，点击**导出文件**。
3. 查看进度与警告；需要停止时点击**取消**。关闭面板也会取消正在读取的任务。
4. 若生成多个参考材料分片，逐个点击文件名保存；关闭面板会释放尚未保存的分片。

| 格式 | 适合用途 |
| :--- | :--- |
| **Markdown** `.md` | 笔记、知识库、版本管理，保留正文中的公式和代码 |
| **JSON** `.json` | 程序处理；保留结构化对话、采集来源、完整性标记和警告 |
| **TXT** `.txt` | UTF-8 文本阅读与搜索；API 正文原有的 Markdown 标记可能仍会保留 |
| **参考材料分片** `.md` | 按消息边界整理可上传的参考材料；单条超长消息保持完整 |

**当前对话**默认优先通过 API 读取当前分支，支持长对话分页。读取失败时可回退到可识别、已加载的页面内容，并标记为部分导出。选择**仅已加载页面（离线）**可跳过 API 读取；未适配的页面布局也可能找不到可导出的正文。

**历史对话**读取当前账号返回的对话列表，可选择列表返回的全部条目，或其中最近的 **50 / 200** 条。不扫描其他工作区，也不保证包含未列出的归档或项目内对话。结果会保留成功读取的对话和失败明细；若全部读取失败，不生成看似成功的空归档。

> **导出文件是归档或参考材料，不是完整账号备份，也不能恢复 ChatGPT 原生聊天记录。** 页面采集可能缺失未加载内容，API、列表覆盖范围及分页安全上限仍有限制。图片和附件只保留可用引用或占位，不打包二进制原文件；完整性警告会留在结果中。

## 面板配置

| 选项 | 默认值 | 作用 |
| :--- | :--- | :--- |
| 导出范围 | 当前对话 | 选择当前对话或可访问的历史列表 |
| 文件格式 | Markdown | 选择下载格式；复制 Markdown 的格式固定不变 |
| 读取方式 | 完整对话优先 | 仅适用于当前对话；可改为只采集已加载页面 |
| 历史数量 | 列表返回的全部 | 仅适用于历史对话；可限制为 50 / 200 条 |
| 包含来源和导出时间 | 开启 | 控制文本、Markdown 及参考分片的可选元数据；JSON 保留结构，警告不受影响 |
| 公式复制 | Markdown | 控制框选、双击及已识别回复按钮的公式定界符 |
| 引用兼容 | 关闭 | 可选的选区文本兼容，用于引用流程 |

<details>
<summary>v0.3.4 更多选项截图</summary>

<p align="center"><img src="docs/assets/formula-copy-options.png" width="340" alt="实际 OmniGPT 0.3.4 面板展开更多选项：读取方式、元数据、Markdown 公式格式及默认关闭的引用兼容"></p>
<p align="center"><sub>使用未修改的 v0.3.4 用户脚本，在全新的无头 Chromium 上加载本地合成示例页截取；展示 UI 渲染，不代表登录态 ChatGPT 的复制或导出验收。</sub></p>

</details>

文件格式、元数据、公式格式与引用兼容保存在当前站点的浏览器本地存储中；范围、读取方式和历史数量在新一次页面加载时恢复默认。这些设置不通过账号同步。

## 兼容性与隐私

- **主要适配目标：** Chrome / Edge、Tampermonkey 和 ChatGPT 网页版。仅匹配 `https://chatgpt.com/*`、`https://chat.openai.com/*`，不向子框架注入。
- **覆盖范围：** Firefox / Violentmonkey、独立桌面客户端和移动端没有完整兼容矩阵；单一环境成功不代表所有浏览器都已验收。
- **页面变化：** ChatGPT 的 DOM 和历史接口不是稳定公共 API。未知布局或操作可能保留原生复制，或无法完成页面导出；复杂表格、纯图片选区及缺少 TeX 源码的公式不保证完整还原。
- **粘贴端：** 支持的数学复制只写入 `text/plain`，不夹带 KaTeX HTML / MathML；目标编辑器及其插件仍可能转换这些文本。

脚本没有广告、遥测或向第三方上传对话的逻辑。框选复制、已识别的回复复制按钮和公式双击不读取剪贴板或请求后端；面板的复制 Markdown 沿用当前对话导出路径，在完整对话优先模式下可能读取对话 API。API 读取复用当前 ChatGPT 登录会话，只向 ChatGPT 站点请求数据；转换和文件生成在浏览器本地进行，无需 API Key。

默认不持续观察、轮询或缓存整页公式，也不全局替换网络、Clipboard API 或选区方法；没有第三方运行时依赖。大批量归档仍会消耗时间和内存，不确定时建议先导出 50 条。

## 常见问题

<details>
<summary><strong>没有入口、版本仍旧，或复制仍是反斜杠定界符？</strong></summary>

确认管理器与正确脚本已在支持的域名启用，只保留一份启用的 OmniGPT，更新后刷新源标签页。在面板核对版本；需要美元符格式时选择**更多选项 → 公式复制 → Markdown**。代码示例本来就保持字面形式。若回复操作未被识别，可尝试框选复制、双击公式或面板的复制 Markdown。更新不会改写剪贴板中已有的内容。

</details>

<details>
<summary><strong>导出不完整或失败？</strong></summary>

先阅读面板和文件中的警告。页面方式只能采集已加载且可识别的内容；历史范围以返回列表为准。确认 ChatGPT 登录会话可用，再缩小范围重试；接口或页面布局变化仍可能需要脚本更新。JSON 与参考分片都不是原生聊天恢复文件。

</details>

反馈时请在 [GitHub Issues](https://github.com/sakur7a/OmniGPT/issues) 附上脚本、浏览器和管理器版本，具体复制或导出入口、简短非私密示例、预期与实际纯文本，以及脱敏错误。不要提交会话 cookie、access token 或私密对话。

## 本地开发

建议使用与 CI 一致的 **Node.js 24**。修改 `src/`，安装用的 `OmniGPT.user.js` 由构建生成。Node 命令使用内置模块；Playwright 仅用于开发阶段的浏览器测试。

```bash
git clone https://github.com/sakur7a/OmniGPT.git
cd OmniGPT
npm run build           # 生成 OmniGPT.user.js
npm run verify:release  # 校验版本与更新元数据
npm run check           # 构建、元数据、语法检查和 Node 回归
```

<details>
<summary>浏览器测试及其验证边界</summary>

先创建并激活 Python 3 虚拟环境：`python -m venv .venv`；PowerShell 使用 `.venv\Scripts\Activate.ps1`，bash/zsh 使用 `source .venv/bin/activate`。然后运行：

```bash
python -m pip install playwright==1.57.0
python -m playwright install chromium
python test/browser-regression.py
python test/browser-v030.py
python test/browser-current-dom.py
```

三个脚本也支持用 `CHROMIUM_PATH` 指定已有 Chromium 可执行文件，例如 PowerShell 中的 `$env:CHROMIUM_PATH = 'C:\path\to\chrome.exe'`。Linux CI 使用 `python -m playwright install --with-deps chromium` 同时安装所需系统依赖。

- **Node 回归：** 公式转换与幂等性、导出格式、分支、分页、重试及模拟 API 响应。
- **浏览器回归：** 代表性 DOM 和模拟站点 API，配合真实 Chromium 键盘、剪贴板/MIME、粘贴、下载和 UI 检查；当前页面结构测试包含两个复制入口、代码/混合内容保护和多正文块。
- **验证边界：** 这些浏览器测试不登录 ChatGPT，也不启动桌面粘贴目标；不能据此宣称真实页面或跨浏览器全场景兼容。

现有 [CI 工作流](.github/workflows/build-userscript.yml) 会对配置范围内的源码、构建和测试改动在发布前运行这些检查；只改 README 不匹配其 push 路径过滤条件。

</details>

```text
OmniGPT/
├─ OmniGPT.user.js              # 生成的可安装用户脚本
├─ src/
│  ├─ clipboard.js              # 公式、选区与回复复制
│  ├─ exporter.js               # API/页面采集与导出格式
│  └─ omnigpt.js                # 面板、选项与任务控制
├─ scripts/
│  ├─ build.mjs                 # 拼接构建用户脚本
│  └─ verify-release.mjs        # 校验版本和更新地址
├─ test/
│  ├─ *.test.mjs               # Node 回归
│  ├─ browser-regression.py
│  ├─ browser-v030.py
│  └─ browser-current-dom.py
├─ docs/                       # 设计说明、版本说明与演示资源
└─ .github/workflows/           # 构建、检查与现有发布流程
```

**相关文档：** [0.3.4 复制修复](docs/V0.3.4.md) · [Web API 兼容性](docs/V0.3.1.md) · [复制机制](docs/CLIPBOARD.md) · [早期设计说明](docs/V0.3.0.md) · [发布与 Greasy Fork 同步](docs/RELEASING.md)。`README.md` 与 `README_EN.md` 为相同的英文指南，本文是中文入口。

---

### 来源与许可

导出逻辑基于此前的 `chatgpt-exporter` 项目整理。LaTeX 兼容思路来自 ChatGPT Better TeX Quote（schweigen，MIT）与 TexCopyer（yjy / blime，GPL-3.0）。详见 [第三方声明](THIRD_PARTY_NOTICES.md)。

[MIT](LICENSE) · [问题反馈](https://github.com/sakur7a/OmniGPT/issues) · [版本记录](https://github.com/sakur7a/OmniGPT/releases)
