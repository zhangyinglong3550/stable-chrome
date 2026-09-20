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
- **稳定元素编号** — `snapshot` 给每个元素分配跨快照不变的 `node`，`click --node` 精准定位；不再出现「看到的编号 ≠ 点到的元素」
- **完整可访问名称** — 图标按钮靠 `aria-label`、`aria-labelledby`、`<label>`、`img alt` 等依次取名字，不再只认可见文字
- **执行前校验** — 元素被改写报 `stale`、被遮挡直接拒绝、disabled 拒绝；带 `changed` 报告页面是否真的变了
- **无 role 控件兜底** — 现代框架的自定义下拉常是裸 `div`/`span`，扫描器会用 `cursor:pointer` 兜底采集（标记 `heuristic: true`）
- **JEV 决策层（可选）** — `sbc decide` 把「下一步点哪里」变成封闭选择题；没配 key 自动降级，不影响任何基础能力
- **DOM 操作** — `click`、`fill`、`eval`、`snapshot`、`screenshot`
- **CDP 网络捕获** — `net-start` / `net-get` / `net-stop` 拦截 XHR/fetch，发现 API
- **Service Worker 保活 + 卡死自愈** — 用 alarms 防止 MV3 后台被挂起；轮询循环卡住超过 60 秒自动换新（含 `bridgeFetch` 超时保护）
- **兼容 Chrome 136+** — 不依赖 `--remote-debugging-port`

---

## JEV 决策层（可选）

`sbc decide --goal "..."` 把「下一步点哪里」从「大模型写一段推理 + 选择器」换成「在封闭选项里选一个」，决策由 [TypeSafe 的 JEV](https://docs.typesafe.ai/introduction) 完成。

```
快照（带稳定编号的元素表）
        │
        ▼
  一次请求并行问三件事：operation / click_target / type_target
        │
        ▼
  {"operation": "CLICK", "targetNode": 14, "confidenceGate": "high", "recommendedAction": "act"}
        │
        ▼
  sbc click --node 14
```

### 它是可选的加速器，不是依赖

**没配 `TYPESAFE_API_KEY` 时不会报错，而是把本该喂给决策器的编号表原样交回**，由你自己的 LLM 决策，再执行 `sbc click --node` / `sbc fill --node`：

```bash
# 有 key：走 JEV
$ sbc decide --goal "把时间维度改成近 7 天"
{ "operation": "CLICK", "targetNode": 14, "targetName": "近 7 天",
  "effectiveConfidence": 0.97, "confidenceGate": "high", "recommendedAction": "act" }

# 没 key：返回编号表（exit 2），调用方自己决策
$ sbc decide --goal "把时间维度改成近 7 天"
{ "ok": false, "reasonCode": "key_missing",
  "hint": "用你自己的 LLM 在下面这份 elements 编号表上决策…",
  "elements": { "e14": { "node": 14, "role": "clickable", "name": "近 7 天" } } }
```

**两条路径的下游完全一致**（都走 `click --node`），所以有没有 JEV 的人用同一套工具、同一套架构，只是决策耗时不同。哪天拿到 key，加个环境变量就生效，调用方代码不用改。

### 可用性探测与统一降级

有 key 不等于能用 —— key 可能无效、欠费、或网络不通。所以 `decide` 会**先探测真实可用性**（一个最小请求，结果落盘缓存：成功信任 10 分钟、失败冷却 5 分钟），失败还会分类：

| 情况 | exit | reasonCode |
|---|---|---|
| 正常 | 0 | — |
| 置信度低于 `--min-confidence` | 3 | `low_confidence` |
| `--no-decider` 主动跳过 | 2 | `decider_disabled` |
| key 无效 / 欠费 / 端点不存在 | 2 | `invalid_key` / `quota_exhausted` / `endpoint_not_found` |
| 网络不通 / 超时 / 限流 | 2 | `unreachable` / `timeout` / `rate_limited` |
| key 未设置 | 2 | `key_missing` |

**所有「决策器给不出答案」的原因都返回同一份编号表**，调用方只需要写一条降级分支。

### 置信度分流

返回 `effectiveConfidence`（取「操作」与「目标」里更低的那个 —— 两个判断都得对）、`confidenceGate`、`recommendedAction`：

| 置信度 | gate | 建议动作 |
|---|---|---|
| ≥ 0.9 | `high` | `act` 直接执行 |
| ≥ 0.5 | `medium` | `recheck` 重新快照再问 |
| < 0.5 | `low` | `escalate` 交回大模型 |

实测有效：同一页面同一个目标，候选完整时 JEV 给出 `0.97` 并选对；候选缺失时只有 `0.43` 且选错 —— **置信度是如实的**。

`decide` 的其余参数：`--min-confidence X`（低于阈值 exit 3 并返回编号表）、`--no-decider`（跳过决策器直接拿编号表）、`--probe`（强制重新探测可用性）、`--allow CLICK,DONE`（限制操作空间）、`--max N`（候选上限）。

### 决策层完全不影响基础能力

决策层只存在于 CLI 进程里，扩展侧完全不知道它的存在（有静态测试逐字断言 `extension/background.js` 里不出现 `typesafe` / `jev` / `decide`）。实测用无效 key 时 `snapshot` / `eval` / `click` 全部照常工作。

### 实测延迟（重要）

JEV 官方 benchmark 是 **~180ms**，但那是服务端算力。从国内经代理访问美西，实测：

| 测量项 | 结果 |
|---|---|
| TCP 建连 | 3ms（本机代理） |
| 最小请求往返 | 1.0 – 2.0s |
| `decide` 端到端 | **1.2 – 4.4s**（中位约 2.1s） |

**所以 JEV 的价值在这边主要是「更可靠的决策 + 更低成本」，不是「更快」**。成本上单次约 1000 input tokens（$0.042/MTok，输出免费），约 **$0.00004/次**。

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

## 升级已有安装

**没有独立的打包/发布流程** —— 仓库本身就是发行版：扩展从 `extension/` 目录直接加载（未打包），CLI 是纯 Python 标准库单文件，skill 是一份 Markdown。升级三步：

```bash
git pull
python3 cli/sbc setup        # 重新同步 SKILL.md 到各 Agent 目录
```

然后到 `chrome://extensions/` 点 stable-chrome 的 🔄 **重新加载** —— 扩展代码变了，MV3 **不会自动热更新**。

**验证**：`python3 cli/sbc doctor` 输出里的 `version` 应为 `0.2.0`；skill 是否同步可对比 `skill/SKILL.md` 与 `~/.claude/skills/stable-chrome/SKILL.md`。

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
| `sbc click --node N` | **按稳定编号点击（推荐）** |
| `sbc click --text TEXT` | 按可见文本点击 |
| `sbc click --selector SEL` | 按 CSS 选择器点击 |
| `sbc click --trusted` | 走 CDP 可信输入（`isTrusted=true`）；会把这个标签提到前台 |
| `sbc click --settle MS` | 动作后等待毫秒数（默认 120，`0` 关闭） |
| `sbc fill --node N --value VAL` | **按稳定编号填写**（也支持 `--selector`） |
| `sbc fill --selector SEL --value VAL` | 填写输入框 |
| `sbc eval 'JS expression'` | 执行 JavaScript 并返回结果 |
| `sbc snapshot [--max N]` | 列出可交互元素（含稳定编号/可访问名称/元素状态，不截图） |
| `sbc decide --goal "..."` | **可选决策层**：有 key 走 JEV，没有则返回编号表（见上文） |
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
| `TYPESAFE_API_KEY` | 空 | 配了 `sbc decide` 才走 JEV；不配则返回编号表 |
| `TYPESAFE_MODEL` | `jev-latest` | 决策模型 |
| `TYPESAFE_URL` | `https://api.typesafe.ai/v1/systemone` | 决策端点 |
| `STABLE_CHROME_DECIDER_STATE` | `~/.stable-chrome/decider-state.json` | 可用性探测的落盘缓存 |

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
