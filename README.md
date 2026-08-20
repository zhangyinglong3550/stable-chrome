# stable-chrome

让 Claude / AI Agent 附着你的**真实 Chrome 浏览器**，复用登录态、Cookie 和已开标签，不需要 `--remote-debugging-port=9222`。

> 作为 Codex `@chrome` 的替代方案，可在 Chrome 136+ 默认用户配置上工作。

中文 | [English](#english)

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

前置：Python 3.8+、Google Chrome。macOS / Linux 可直接跑仓库里的 `.sh`；Windows 用下方 PowerShell 步骤（已装 Git Bash / WSL 的也可走 macOS / Linux 流程）。

### macOS / Linux

```bash
git clone https://github.com/YOUR_USERNAME/stable-chrome.git
cd stable-chrome
./scripts/install.sh          # 检查 Python 3.8+，生成扩展图标，把 sbc 链到 PATH

export PATH="$PATH:$(pwd)/cli"
# 或
ln -s "$(pwd)/cli/sbc" /usr/local/bin/sbc
```

Chrome 加载扩展：

1. 打开 `chrome://extensions/`
2. 打开右上角 **开发者模式**
3. **加载已解压的扩展程序** → 选仓库里的 `extension/`
4. 记下扩展 ID

启动 Bridge 并自检：

```bash
./scripts/start-bridge.sh     # 默认 http://127.0.0.1:19527
sbc doctor                    # extension.online 应为 true
```

环境变量可覆盖：`STABLE_CHROME_PORT`、`STABLE_CHROME_HOST`。停止：`./scripts/stop-bridge.sh`。

### Windows

Windows 没有 `chmod` / `nohup` / `lsof`，不要跑 `scripts/*.sh`（除非在 Git Bash 或 WSL 里）。Bridge 和 CLI 都是纯 Python，用系统 Python 即可。

1. 安装 [Python 3.8+](https://www.python.org/downloads/windows/)，勾选 **Add python.exe to PATH**。确认：

   ```powershell
   python --version
   ```

2. 克隆仓库（PowerShell）：

   ```powershell
   git clone https://github.com/YOUR_USERNAME/stable-chrome.git
   cd stable-chrome
   ```

3. Chrome 加载扩展（与 macOS 相同）：`chrome://extensions/` → **开发者模式** → **加载已解压的扩展程序** → 选本仓库的 `extension` 文件夹。工具栏图标缺失可忽略（Chrome 用默认图标）；若要生成图标，在 Git Bash 里跑一次 `./scripts/install.sh`。

4. 开一个终端前台跑 Bridge（关掉这个窗口等于停服务）：

   ```powershell
   python bridge\server.py
   ```

   默认监听 `http://127.0.0.1:19527`。换端口：

   ```powershell
   $env:STABLE_CHROME_PORT = "19527"
   $env:STABLE_CHROME_HOST = "127.0.0.1"
   python bridge\server.py
   ```

   需要后台跑时，另开一个最小化窗口即可，不要关。端口被占用时：

   ```powershell
   Get-NetTCPConnection -LocalPort 19527 -ErrorAction SilentlyContinue |
     Select-Object OwningProcess
   Stop-Process -Id <PID> -Force
   ```

5. **另开一个** PowerShell，用 Python 调 CLI（Windows 不会执行 `cli\sbc` 的 shebang，必须显式 `python`）：

   ```powershell
   python cli\sbc doctor
   ```

   `extension.online` 应为 `true`。之后所有命令都是同一形式：

   ```powershell
   python cli\sbc health
   python cli\sbc open-tabs
   python cli\sbc start-task --title "deploy-prod"
   python cli\sbc new-tab --url "https://example.com"
   ```

   想少打字，可在当前会话加函数：

   ```powershell
   function sbc { python "$PWD\cli\sbc" @args }
   sbc doctor
   ```

把 Skill 拷到 Claude Code（Windows）：

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude\skills\stable-chrome" | Out-Null
Copy-Item skill\SKILL.md "$env:USERPROFILE\.claude\skills\stable-chrome\SKILL.md"
```

---

## CLI 速查

| 命令 | 作用 |
|---|---|
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

Windows 把上表里的 `sbc` 换成 `python cli\sbc`。

---

## 作为 Claude Code Skill 使用

把 `skill/SKILL.md` 拷到（或软链到）`~/.claude/skills/stable-chrome/`：

```bash
mkdir -p ~/.claude/skills/stable-chrome
cp skill/SKILL.md ~/.claude/skills/stable-chrome/SKILL.md
```

Windows 见上方 PowerShell 拷贝命令。之后对 Claude 说：

> 「用 stable-chrome 打开部署页面并点击发布」

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
macOS / Linux：跑 `./scripts/start-bridge.sh`，再 `sbc health`。  
Windows：确认 `python bridge\server.py` 那个窗口还在，再 `python cli\sbc health`。

**命令超时**  
扩展可能在执行中途被挂起。先 `sbc doctor`（Windows：`python cli\sbc doctor`），离线则重载扩展再试。

**Windows 提示找不到 `sbc`**  
这是正常的：`cli\sbc` 没有 `.exe`。请用 `python cli\sbc ...`。

**Windows 扩展加载后没有自定义图标**  
可忽略。或在 Git Bash / WSL 里跑 `./scripts/install.sh` 生成 `extension/icons/`，再重载扩展。

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

### How it works

CLI/Skill → local Bridge (`http://127.0.0.1:19527`) → Chrome MV3 extension long-poll → real tabs. No CDP port, no profile copy, no headless browser.

### macOS / Linux

```bash
git clone https://github.com/YOUR_USERNAME/stable-chrome.git
cd stable-chrome
./scripts/install.sh
export PATH="$PATH:$(pwd)/cli"
# Chrome: chrome://extensions → Developer mode → Load unpacked → extension/
./scripts/start-bridge.sh
sbc doctor
```

### Windows

Do **not** run `scripts/*.sh` in cmd/PowerShell (Git Bash / WSL is fine). Use Python 3.8+:

```powershell
git clone https://github.com/YOUR_USERNAME/stable-chrome.git
cd stable-chrome
python bridge\server.py          # keep this window open
# another terminal:
python cli\sbc doctor
```

Load unpacked extension from `extension\`. Generate icons first if they are missing (see the Chinese Windows section). Prefix every CLI call with `python cli\sbc` — the shebang in `cli\sbc` is ignored on Windows.

### CLI / config / troubleshooting

See the Chinese tables above. Windows equivalents: `sbc` → `python cli\sbc`; env vars → `$env:NAME = "value"`; stop the bridge by closing the Python window or killing the process on port `19527`.
