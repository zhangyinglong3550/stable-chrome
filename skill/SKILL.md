---
name: stable-chrome
description: 稳定附着用户真实 Chrome（不依赖 9222），支持 openTabs/claim/任务标签分组/DOM 操作。用于需要登录态的内网页面自动化、部署、联调。Use when user asks to control real Chrome, reuse login session, open tab groups, or when CDP/9222 connection fails.
---

# stable-chrome

独立于 Codex 的真实 Chrome 附着能力。

## 架构一句话
CLI/Agent → 本地 Bridge(`http://127.0.0.1:19527`) → Chrome 扩展 poll 命令 → 在真实标签上执行。

## 前置
1. Bridge 运行：`~/code/stable-chrome/scripts/start-bridge.sh`
2. Chrome 已加载解压扩展：`~/code/stable-chrome/extension`
3. `sbc doctor` 显示 `extension.online=true`

## 推荐工作流
```bash
sbc doctor
sbc open-tabs
# 同会话只 start-task 一次；默认独立后台窗口，不和用户抢同一窗
sbc start-task --title "deploy-core"
sbc new-tab --url "https://example.com"   # 同任务默认永远单标签（后台）
sbc new-tab --url "https://example.com/next"  # 再次调用 = 同标签导航，不新开
# 等价写法：sbc goto "https://example.com/next"
# 真要第二页：sbc new-tab --url "..." --force
sbc snapshot
sbc click --text "登录"
sbc fill --selector "input[name=user]" --value "xxx"
sbc screenshot --out /tmp/a.png           # 优先 CDP 截图，不切用户标签
sbc end-task
```

## 命令速查
| 命令 | 作用 |
|---|---|
| `sbc health` | bridge 健康 |
| `sbc doctor` | 扩展是否在线 |
| `sbc open-tabs` | 列出真实标签 |
| `sbc claim [--tab-id] [--window]` | 接管标签并建任务组；`--window` 拆到独立后台窗 |
| `sbc start-task [--title]` | 开始/复用任务组；**默认独立后台窗**；`--same-window` 才同窗 |
| `sbc new-tab --url` | 同任务默认单标签：有 claimed 则导航复用；`--force` 才新建第二页 |
| `sbc close-tab [--tab-id]` | 关闭标签（默认可关当前 claimed） |
| `sbc goto URL` | 在已 claim 标签上导航（与默认 new-tab 等价） |
| `sbc click --selector|--text|--index` | 点击 |
| `sbc fill --selector --value` | 输入 |
| `sbc eval 'document.title'` | 执行 JS |
| `sbc snapshot` | 可见可交互元素 |
| `sbc content` | 读正文摘要 |
| `sbc wait --text|--selector` | 等待 |
| `sbc screenshot --out` | 截图（优先 CDP `Page.captureScreenshot`，不切标签；失败才降级） |
| `sbc end-task [--close-group]` | 结束任务 |
| `sbc net-start [--tab-id]` | 开始 CDP 网络捕获 |
| `sbc net-get [--tab-id] [--grep STR]` | 读取捕获的 API 请求（不停止） |
| `sbc net-stop [--tab-id] [--grep STR]` | 停止捕获并输出所有请求 |

## 硬规则
1. **禁止**默认使用 9222 / 复制 profile / 匿名 Chromium 冒充连接成功
2. 扩展离线时：先 `start-bridge.sh` + 确认扩展已加载，再重试
3. 自动化页面必须进任务标签分组，减少干扰用户日常浏览
4. 内网登录页：优先 `claim` 用户已登录标签，不要新开匿名页硬登
5. **默认不抢浏览器焦点**：`claim` / `start-task` / `new-tab` / `goto` 均静默后台执行；只有显式 `--focus` / `--active` 才前置窗口。
6. **`start-task` 默认独立窗口**（unfocused）：Agent 与用户分窗；只有用户明确要求同窗时才用 `--same-window`。
7. **截图默认不切标签**：优先 `chrome.debugger` → `Page.captureScreenshot`；仅 CDP 失败时才短暂 `captureVisibleTab` 并恢复。
8. 新建任务标签分组颜色自动轮换（可 `start-task --color green` 指定）；复用已有分组不覆盖颜色
9. **同会话复用**：`start-task` 可重复调用，状态跨扩展 SW 重启持久化；不要为每个子步骤再 `start-task` 一套
10. **同任务永远单标签**：`new-tab` 默认 = 导航复用 claimed 标签；只有显式 `--force` 才开第二页
11. **不收养用户工作区分组**：`claim` / `start-task` 不会把你已有的标签组改名成任务组；会把目标标签拆出单独建 Agent 组

## Agent 用法注意
- 一次会话：`start-task` 一次（默认独立窗）→ 反复 `new-tab --url` 只会在同一标签跳转
- 不要加 `--same-window`，除非用户明确要求在当前窗口操作
- 真要并行两个页面：`sbc new-tab --url ... --force`
- 开页请用 `sbc new-tab --url ...`（默认后台），**不要**加 `--active` 除非用户要求看页面
- 不要 `claim --focus`，除非用户明确说「切到这个标签」
- **不要 claim 用户正在工作的标签**，除非用户明确要求接管；优先 `start-task` + `new-tab`
- 任务组标题默认 `Agent Task`；需要语义化时传 `--title "deploy-core"` 等
- 任务组颜色：省略则自动随机；需要固定色用 `--color`
- 截图结果里 `method: "debugger"` 表示无焦点干扰；若落到 `captureVisibleTab` 才可能闪一下

## 故障排查
```bash
sbc doctor
# 看 extension.online / hints
# 扩展 service worker 控制台应持续请求 /ext/poll
# 改完 extension 后：sbc reload-extension（或 chrome://extensions 点重新加载）
```

## 实现路径
安装后在仓库根目录找到对应文件：
- CLI：`cli/sbc`（建议加入 PATH）
- Bridge：`bridge/server.py`
- Chrome 扩展：`extension/`
- 启动脚本：`scripts/start-bridge.sh`
