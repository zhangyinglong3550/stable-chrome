# stable-chrome

让 Claude / AI Agent 附着你的**真实 Chrome 浏览器**，复用登录态、Cookie 和已开标签，不需要 `--remote-debugging-port=9222`。

> 作为 Codex `@chrome` 的替代方案，可在 Chrome 136+ 默认用户配置上工作。

中文 | [English](#english)

**任意 Agent 安装（一句话）：** 在仓库根目录执行 `python3 cli/sbc setup`（Windows：`python cli\sbc setup`），然后请用户在打开的 Chrome 扩展页开启开发者模式，加载已解压扩展（目录见输出 `extensionDir`）。

---

## 工作原理

```
Claude Skill / CLI (sbc)
        │  HTTP  http://127.0.0.1:19527
        ▼
Bridge Server  （本地，仅 Python 标准库）
        │  长轮询命令队列
        ▼
Chrome 扩展（MV3）
  chrome.tabs / tabGroups / scripting / debugger
        ▼
你的真实 Chrome（已登录，Cookie 完整）
```

不占用 CDP 端口，不复制用户配置，不开无头浏览器。扩展向本地 Bridge 长轮询，在真实标签里执行命令并返回结果。

---

## 功能

- **真实登录态** — 复用内网、VPN、SSO 会话
- **任务标签分组** — 每个任务独立着色分组，不打乱日常浏览
- **DOM 操作** — `click`、`fill`、`eval`、`snapshot`、`screenshot`
- **CDP 网络捕获** — `net-start` / `net-get` / `net-stop` 拦截 XHR/fetch，发现 API
- **Service Worker 保活** — 用 alarms 防止 MV3 后台被 Chrome 挂起
- **兼容 Chrome 136+** — 不依赖 `--remote-debugging-port`

---

## 快速开始

前置：Python 3.8+、Google Chrome。人机同一条命令：

```bash
python3 cli/sbc setup          # Windows: python cli\sbc setup
```

`setup` 会生成图标、把 skill 拷到常见 Agent 目录（Claude / Cursor / Codex / 通用 `.agents`）、启动 Bridge、打开 `chrome://extensions`。Chrome 不允许脚本静默安装未打包扩展，所以最后请用户：**开发者模式 → 加载已解压 → 输出里的 `extensionDir`**。然后 `python3 cli/sbc doctor`，`extension.online` 应为 `true`。

环境变量可覆盖：`STABLE_CHROME_PORT`、`STABLE_CHROME_HOST`。停止 Bridge：`./scripts/stop-bridge.sh`（Windows 关掉 `setup` 拉起的 Python 进程，或结束 19527 端口）。

macOS / Linux 也可以 `./scripts/install.sh`，它只是 `sbc setup` 的包装。Windows 不要跑 `.sh`，直接 `python cli\sbc setup`。

想少打字（当前会话）：

```bash
# macOS / Linux
export PATH="$PATH:$(pwd)/cli"

# Windows PowerShell
function sbc { python "$PWD\cli\sbc" @args }
```

---

## CLI 速查

| 命令 | 作用 |
|---|---|
| `sbc setup` | 装 skill、起 Bridge、打开扩展页 |
| `sbc health` | Bridge 是否存活 |
| `sbc doctor` | 完整诊断（Bridge + 扩展） |
| `sbc open-tabs` | 列出真实 Chrome 标签 |
| `sbc start-task --title NAME` | 创建任务标签分组 |
| `sbc end-task [--close-group]` | 结束任务 |
| `sbc claim [--tab-id ID]` | 接管标签并入任务组 |
| `sbc new-tab --url URL` | 任务组内开页（默认复用单标签） |
| `sbc goto URL [--tab-id ID]` | 导航 |
| `sbc click --text TEXT` | 按可见文本点击 |
| `sbc click --selector SEL` | 按 CSS 选择器点击 |
| `sbc fill --selector SEL --value VAL` | 填写输入框 |
| `sbc eval 'JS expression'` | 执行 JavaScript 并返回结果 |
| `sbc snapshot [--tab-id ID]` | 列出可交互元素（不截图） |
| `sbc content [--tab-id ID]` | 读页面正文 |
| `sbc wait --text T [--timeout-ms N]` | 等待文本或选择器 |
| `sbc screenshot --out PATH` | 截取可见标签 |
| `sbc reload [--bypass-cache]` | 刷新标签 |
| `sbc net-start [--tab-id ID]` | 开始 CDP 网络捕获 |
| `sbc net-get [--grep STR]` | 读取已捕获请求（不停止） |
| `sbc net-stop [--grep STR]` | 停止捕获并打印全部请求 |
| `sbc cookie-get [--name NAME] [--url URL] [--tab-id ID]` | 读 cookie（**含 HttpOnly**）；输出**含明文值**，别粘进日志/对话 |

Windows 把上表里的 `sbc` 换成 `python cli\sbc`。

> `cookie-get` 走 CDP `Network.getCookies`，复用扩展已有的 `debugger` 权限，
> **不需要 manifest 增加 `cookies` 权限**（避免触发 Chrome 权限变更重新授权）。
> 用途：内网控制台凭证基本都是登录态 cookie，`document.cookie` 读不到 HttpOnly，
> 而 DevTools 能读正是因为它走 CDP——扩展现在具备同样的能力。

---

## 作为任意 Agent 的 Skill

`sbc setup` 会把 `skill/SKILL.md` 拷到：

- `~/.claude/skills/stable-chrome/`
- `~/.cursor/skills/stable-chrome/`
- `~/.codex/skills/stable-chrome/`
- `~/.agents/skills/stable-chrome/`

仓库根还有 `AGENTS.md`：打开本项目的 Agent 不装 skill 也能看到那句安装命令。之后对 Agent 说「用 stable-chrome 打开部署页面并点击发布」即可。

---

## 典型工作流

```bash
sbc doctor
sbc open-tabs
sbc start-task --title "deploy-prod"
sbc new-tab --url "https://your-internal-ci.example.com"

# 发现 API，不必截图
sbc net-start
sbc eval "document.querySelector('#deploy-btn')?.click()"
sbc net-stop --grep "/api/deploy"

# 确认结果
sbc eval "document.body.innerText.slice(0,500)"
sbc end-task
```

---

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `STABLE_CHROME_PORT` | `19527` | Bridge 端口 |
| `STABLE_CHROME_HOST` | `127.0.0.1` | Bridge 绑定地址 |
| `STABLE_CHROME_EXT_TTL_MS` | `32000` | 超过此时长未见扩展心跳则视为离线 |
| `STABLE_CHROME_CMD_TIMEOUT_MS` | `20000` | 默认命令超时 |
| `STABLE_CHROME_LOG_DIR` | `logs/` | 日志目录 |

Windows PowerShell 设置环境变量：`$env:STABLE_CHROME_PORT = "19527"`。

---

## 排障

**扩展约 20 秒后离线**  
Chrome 会挂起 MV3 Service Worker。内置 alarm 每 15 秒唤醒一次。若仍离线，到 `chrome://extensions/` 点重新加载。

**连不上 Bridge**  
跑 `python3 cli/sbc setup`（或 `./scripts/start-bridge.sh`），再 `sbc health`。Windows：`python cli\sbc setup`。

**命令超时**  
扩展可能在执行中途被挂起。先 `sbc doctor`（Windows：`python cli\sbc doctor`），离线则重载扩展再试。

**Windows 提示找不到 `sbc`**  
这是正常的：`cli\sbc` 没有 `.exe`。请用 `python cli\sbc ...`。`setup` 不会在 Windows 上做 PATH 软链。

---

## 规则

1. **禁止**回退到 `--remote-debugging-port=9222` 或复制默认用户配置
2. 自动化标签**必须**进任务分组，不要污染用户日常浏览
3. 内网页：`claim` 已登录标签，不要新开匿名页硬登
4. 出错即失败，不做静默降级

---

## License

MIT

---

## English

Attach Claude / AI agents to your **real Chrome browser** — reusing login sessions, cookies, and open tabs — without `--remote-debugging-port=9222`.

The Chinese section above is the canonical docs. This is a short English recap.

**Any-agent install:** from the repo root run `python3 cli/sbc setup` (Windows: `python cli\sbc setup`). Ask the user to enable Developer mode and Load unpacked using `extensionDir` from the output. Then `doctor` until `extension.online` is true. Never use `--remote-debugging-port=9222`.

### How it works

CLI/Skill → local Bridge (`http://127.0.0.1:19527`) → Chrome MV3 extension long-poll → real tabs. No CDP port, no profile copy, no headless browser.

### macOS / Linux / Windows

```bash
git clone https://github.com/YOUR_USERNAME/stable-chrome.git
cd stable-chrome
python3 cli/sbc setup          # Windows: python cli\sbc setup
```

Load unpacked from `extensionDir`. Then `python3 cli/sbc doctor`.

### CLI / config / troubleshooting

See the Chinese tables above. Windows equivalents: `sbc` → `python cli\sbc`; env vars → `$env:NAME = "value"`; stop the bridge by closing the Python window or killing the process on port `19527`.
