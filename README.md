# stable-chrome

Attach Claude / AI agents to your **real Chrome browser** — reusing login sessions, cookies, and open tabs — without `--remote-debugging-port=9222`.

> Built as a drop-in alternative to Codex `@chrome` that works on Chrome 136+ default profiles.

English | [中文](#中文说明)

---

## How it works

```
Claude Skill / CLI (sbc)
        │  HTTP  http://127.0.0.1:19527
        ▼
Bridge Server  (local, stdlib Python)
        │  long-poll command queue
        ▼
Chrome Extension  (MV3)
  chrome.tabs / tabGroups / scripting / debugger
        ▼
Your real Chrome  (logged in, cookies intact)
```

No CDP port. No profile copy. No headless browser. The extension long-polls a local bridge, executes commands inside your real tabs, and returns results.

---

## Features

- **Real login state** — reuse sessions for internal tools, VPNs, SSO
- **Tab groups** — every task gets its own colour-coded tab group; no mess in your browser
- **DOM-level control** — `click`, `fill`, `eval`, `snapshot`, `screenshot`
- **CDP Network capture** — `net-start/net-get/net-stop` intercept all XHR/fetch calls to discover API endpoints
- **SW keep-alive** — MV3 service worker stays alive via alarms even after Chrome suspends it
- **Works on Chrome 136+** — no `--remote-debugging-port` flag required

---

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/stable-chrome.git
cd stable-chrome
./scripts/install.sh          # checks Python 3.8+, makes sbc executable
```

Add `cli/` to your PATH (or symlink `cli/sbc` to `/usr/local/bin/sbc`):

```bash
export PATH="$PATH:$(pwd)/cli"
# or
ln -s $(pwd)/cli/sbc /usr/local/bin/sbc
```

### 2. Load the Chrome extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. Note the extension ID (shown under the extension name)

### 3. Start the bridge

```bash
./scripts/start-bridge.sh
```

Bridge listens on `http://127.0.0.1:19527` by default.  
Override with env vars: `STABLE_CHROME_PORT`, `STABLE_CHROME_HOST`.

### 4. Verify

```bash
sbc doctor
```

You should see `"online": true` under `extension`.

---

## CLI reference

| Command | Description |
|---|---|
| `sbc health` | bridge alive? |
| `sbc doctor` | full diagnostics (bridge + extension) |
| `sbc open-tabs` | list all real Chrome tabs |
| `sbc start-task --title NAME` | create task tab group |
| `sbc end-task [--close-group]` | end task |
| `sbc claim [--tab-id ID]` | claim a tab into the task group |
| `sbc new-tab --url URL` | open new tab in task group |
| `sbc goto URL [--tab-id ID]` | navigate |
| `sbc click --text TEXT` | click by visible text |
| `sbc click --selector SEL` | click by CSS selector |
| `sbc fill --selector SEL --value VAL` | fill input |
| `sbc eval 'JS expression'` | run JavaScript, return result |
| `sbc snapshot [--tab-id ID]` | list interactive elements (no screenshot) |
| `sbc content [--tab-id ID]` | read page text |
| `sbc wait --text T [--timeout-ms N]` | wait for text/selector |
| `sbc screenshot --out PATH` | capture visible tab |
| `sbc reload [--bypass-cache]` | reload tab |
| `sbc net-start [--tab-id ID]` | start CDP network capture |
| `sbc net-get [--grep STR]` | read captured requests (live) |
| `sbc net-stop [--grep STR]` | stop capture, print all requests |

---

## Use as a Claude Code skill

Copy (or symlink) `skill/SKILL.md` to `~/.claude/skills/stable-chrome/`:

```bash
mkdir -p ~/.claude/skills/stable-chrome
cp skill/SKILL.md ~/.claude/skills/stable-chrome/SKILL.md
```

Claude Code will automatically load it. Ask Claude to:

> "Use stable-chrome to open the deploy page and click the publish button"

---

## Typical workflow

```bash
sbc doctor
sbc open-tabs
sbc start-task --title "deploy-prod"
sbc new-tab --url "https://your-internal-ci.example.com"

# discover API endpoints (no screenshots needed)
sbc net-start
sbc eval "document.querySelector('#deploy-btn')?.click()"
sbc net-stop --grep "/api/deploy"

# confirm result
sbc eval "document.body.innerText.slice(0,500)"
sbc end-task
```

---

## Configuration

| Env var | Default | Description |
|---|---|---|
| `STABLE_CHROME_PORT` | `19527` | bridge port |
| `STABLE_CHROME_HOST` | `127.0.0.1` | bridge bind host |
| `STABLE_CHROME_EXT_TTL_MS` | `32000` | ms before extension considered offline |
| `STABLE_CHROME_CMD_TIMEOUT_MS` | `20000` | default command timeout |
| `STABLE_CHROME_LOG_DIR` | `logs/` | log directory |

---

## Troubleshooting

**Extension goes offline after ~20s**  
The MV3 service worker is suspended by Chrome. The built-in alarm wakes it every 15s. If it stays offline, reload the extension in `chrome://extensions/`.

**Bridge not reachable**  
Run `./scripts/start-bridge.sh` and check `sbc health`.

**Command times out**  
The extension might have been suspended mid-command. Run `sbc doctor`, reload extension if offline, retry.

---

## Rules

1. **Never** fall back to `--remote-debugging-port=9222` or copy the default profile
2. All automated tabs **must** be in a task group (don't pollute the user's browser)
3. For intranet pages: `claim` an already-logged-in tab, never open a fresh anonymous tab
4. Errors are hard failures — no silent degradation

---

## License

MIT

---

## 中文说明

让 Claude / AI Agent 附着你的**真实 Chrome 浏览器**，复用登录态、Cookie 和已开标签，不需要 `--remote-debugging-port=9222`。

### 架构

`CLI/Agent → 本地 Bridge(:19527) → Chrome 扩展 long-poll ← 在真实标签执行`

### 安装

```bash
git clone https://github.com/YOUR_USERNAME/stable-chrome.git
cd stable-chrome
./scripts/install.sh

# 加入 PATH
export PATH="$PATH:$(pwd)/cli"

# Chrome 加载扩展：chrome://extensions → 开发者模式 → 加载已解压 → 选 extension/
./scripts/start-bridge.sh
sbc doctor
```

### 作为 Claude Code Skill 使用

```bash
mkdir -p ~/.claude/skills/stable-chrome
cp skill/SKILL.md ~/.claude/skills/stable-chrome/SKILL.md
```

之后对 Claude 说"用 stable-chrome 打开部署页面并点击发布"即可。
