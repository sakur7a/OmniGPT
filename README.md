# OmniGPT

<div align="center">

<strong>让 ChatGPT 对话真正可带走，让数学公式真正可复制。</strong>

<br>

导出当前或全部聊天记录，复制为保留 LaTeX 的纯文本 Markdown。

<br><br>

<a href="https://greasyfork.org/zh-CN/scripts/590463-omnigpt-chatgpt-export-latex-copy"><img alt="Install from Greasy Fork" src="https://img.shields.io/badge/安装-Greasy_Fork-2f2f2f?style=for-the-badge&logo=tampermonkey&logoColor=white"></a>
<a href="https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js"><img alt="Install from GitHub" src="https://img.shields.io/badge/备用安装-GitHub_Raw-181717?style=for-the-badge&logo=github"></a>

<br><br>

<a href="https://github.com/sakur7a/OmniGPT/blob/main/package.json"><img alt="OmniGPT version" src="https://img.shields.io/github/package-json/v/sakur7a/OmniGPT?style=flat-square&label=version&color=8ee3ad"></a>
<a href="LICENSE"><img alt="GPL-3.0-or-later" src="https://img.shields.io/github/license/sakur7a/OmniGPT?style=flat-square&color=8ee3ad"></a>
<img alt="No telemetry" src="https://img.shields.io/badge/telemetry-none-8ee3ad?style=flat-square">

</div>

## 0.2.1：跨应用复制与轻量模式

含公式选区通过 `Ctrl+C` 复制时，仅写入 `text/plain` Markdown，不再让 KaTeX 的 HTML / MathML 渲染副本混入剪贴板。块级公式使用独占行的 `$$`，代码块缩进和空行保持不变；同一公式的多层渲染不会重复输出。目标应用自己的粘贴插件仍可能再次改写纯文本。

默认不再持续观察整个页面、不扫描流式生成节点、不向公式写缓存属性，也不全局改写选区方法。仅复制或双击时处理选中内容。需要 ChatGPT 原生选区引用兼容时，在面板开启 **引用兼容（默认关闭）**；普通复制不需要开启。

**更新后务必刷新已打开的 ChatGPT 页面，并重新复制内容。** 旧页面里的 0.2.0 监听器不会随脚本文件更新而自动卸载。只保留一份启用的 OmniGPT。

详细行为、测试与边界见 [Clipboard / 性能说明](docs/CLIPBOARD.md)。

## Demo

### 一个面板，四种去向

当前对话可下载或复制；全部历史可整理为归档或 GPT 参考导入包。下图为早期面板演示，现版另有引用兼容开关。

![OmniGPT export panel](docs/assets/export-panel.png)

### 分屏时自动让开输入框

宽屏显示完整按钮；窄窗口收拢为右侧圆形入口。

![OmniGPT responsive split view](docs/assets/split-view.png)

## 能做什么

| 场景 | OmniGPT 的处理 |
| --- | --- |
| 当前对话导出 | API-first；失败时回退 DOM。DOM 回退只能获取页面当时已加载的内容 |
| 全部历史导出 | 复用登录会话，分页读取历史并记录失败项 |
| Markdown / JSON / TXT | 文本归档或程序处理 |
| GPT 导入包 | 拆分为可上传的参考 Markdown，不是原生历史恢复文件 |
| 复制 Markdown | 将当前对话写入纯文本剪贴板 |
| 选区 / 双击公式复制 | 恢复源 TeX，行内 `$...$`、块级 `$$...$$` |
| 原生选区引用 | 可选兼容模式，默认关闭；并不保证所有站点引用实现都使用相同文本接口 |

## 安装与更新

安装 [Tampermonkey](https://www.tampermonkey.net/) 或兼容管理器后，打开 [Greasy Fork 安装页](https://greasyfork.org/zh-CN/scripts/590463-omnigpt-chatgpt-export-latex-copy) 或 [GitHub Raw 脚本](https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js)。确认版本后安装并刷新 ChatGPT。

从 Greasy Fork 安装的版本需要该站先同步新版本；GitHub 发布成功不代表 Greasy Fork 同步已经完成。发布及一次性同步设置见 [RELEASING.md](docs/RELEASING.md)。

## 使用

打开对话后，点击右下角 **OmniGPT**，窄屏点击右侧 **O**；选择导出范围与格式。读取 API 仅由导出操作触发。

框选含公式的回复并 `Ctrl+C`，或双击单个公式，复制为纯文本 Markdown。只选中部分公式也会恢复该公式的完整 TeX。非公式选区和输入框内的复制保留原生行为。原生回复底部的复制按钮可能直接调用站点自己的 Clipboard API；脚本不全局劫持该接口。

需要原生选区引用保留 TeX 时，开启面板中的 **引用兼容**。该模式仅包装消息内公式选区的文本序列化，不改写 `Range.cloneContents`；关闭后恢复仍由 OmniGPT 管理的方法。

## 隐私与权限

没有分析、广告、遥测或第三方上传。复制不请求后端，不读取剪贴板。导出只向当前 ChatGPT 站点请求数据，文件生成在浏览器本地完成。脚本仅匹配 `chatgpt.com` 和旧版 `chat.openai.com`，不在子框架注入。

ChatGPT 页面和内部接口并非稳定公共 API。提交问题时，请提供浏览器版本、脚本版本、具体复制方式及脱敏后的 `[OmniGPT]` 错误；不要提交 access token 或会话 cookie。

## 本地开发

运行时无第三方依赖。CI 使用 Node.js 24，浏览器测试的 Playwright 仅用于开发，不打包进脚本。

```bash
git clone https://github.com/sakur7a/OmniGPT.git
cd OmniGPT
npm run check
# 可选本地浏览器回归；CI 会在发布前执行
python -m venv .venv
# 激活虚拟环境后：
python -m pip install playwright==1.57.0
python -m playwright install chromium
npm run test:browser
```

```text
OmniGPT.user.js          # 生成的可安装脚本
src/clipboard.js        # 按需 TeX / 选区处理、纯文本剪贴板、可选引用兼容
src/exporter.js         # API / DOM 采集、格式化、下载
src/omnigpt.js          # 面板和复制功能初始化
scripts/build.mjs       # 从 package.json 读取版本并构建
test/omnigpt.test.mjs    # Node 回归测试
test/browser-regression.py # Chromium 真实剪贴板和 DOM 回归
```

## 兼容性与反馈

主要面向 Chrome、Edge 与 Tampermonkey。Chromium 自动测试不等同于完整的微信、Obsidian、ChatGPT 登录态或 Firefox / Violentmonkey 手工矩阵。

问题反馈：[GitHub Issues](https://github.com/sakur7a/OmniGPT/issues)。

## 来源与许可

导出逻辑基于此前的 `chatgpt-exporter` 项目整理。LaTeX 兼容思路来自 ChatGPT Better TeX Quote（schweigen，MIT）与 TexCopyer（yjy / blime，GPL-3.0）；完整说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

OmniGPT 以 [GPL-3.0-or-later](LICENSE) 发布。
