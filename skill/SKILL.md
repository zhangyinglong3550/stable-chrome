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
sbc start-task --title "deploy-core"
sbc new-tab --url "https://example.com"
sbc snapshot
sbc click --text "登录"
sbc fill --selector "input[name=user]" --value "xxx"
sbc screenshot --out /tmp/a.png
sbc end-task
```

## 命令速查
| 命令 | 作用 |
|---|---|
| `sbc health` | bridge 健康 |
| `sbc doctor` | 扩展是否在线 |
| `sbc open-tabs` | 列出真实标签 |
| `sbc claim [--tab-id]` | 接管标签并建任务组 |
| `sbc start-task --title` | 开始任务/分组 |
| `sbc new-tab --url` | 新标签（进任务组） |
| `sbc goto URL` | 导航 |
| `sbc click --selector|--text|--index` | 点击 |
| `sbc fill --selector --value` | 输入 |
| `sbc eval 'document.title'` | 执行 JS |
| `sbc snapshot` | 可见可交互元素 |
| `sbc content` | 读正文摘要 |
| `sbc wait --text|--selector` | 等待 |
| `sbc screenshot --out` | 截图 |
| `sbc end-task [--close-group]` | 结束任务 |
| `sbc net-start [--tab-id]` | 开始 CDP 网络捕获 |
| `sbc net-get [--tab-id] [--grep STR]` | 读取捕获的 API 请求（不停止） |
| `sbc net-stop [--tab-id] [--grep STR]` | 停止捕获并输出所有请求 |

## 硬规则
1. **禁止**默认使用 9222 / 复制 profile / 匿名 Chromium 冒充连接成功
2. 扩展离线时：先 `start-bridge.sh` + 确认扩展已加载，再重试
3. 自动化页面必须进任务标签分组，减少干扰用户日常浏览
4. 内网登录页：优先 `claim` 用户已登录标签，不要新开匿名页硬登

## 故障排查
```bash
sbc doctor
# 看 extension.online / hints
# 扩展 service worker 控制台应持续请求 /ext/poll
```

## 实现路径
安装后在仓库根目录找到对应文件：
- CLI：`cli/sbc`（建议加入 PATH）
- Bridge：`bridge/server.py`
- Chrome 扩展：`extension/`
- 启动脚本：`scripts/start-bridge.sh`
