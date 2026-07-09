# stable-chrome 设计说明

## 目标
做一套**不依赖 Codex**、且稳定性接近 Codex `@chrome` 的真实浏览器附着能力。

## 为什么不用 9222
Chrome 136+ 对默认 profile 拒绝 `--remote-debugging-port`：
- 进程参数里可能有 9222
- 但端口不监听
- `DevToolsActivePort` 可能是残留

因此主路径必须是 **扩展附着**。

## 为什么不用 Native Messaging 作为 CLI 入口
Native Messaging 只能由扩展发起连接（`connectNative`）。
CLI 无法主动给扩展发命令，除非：
1. 扩展先连 host，且 host 是常驻多路复用进程（复杂）
2. 或 CLI 写文件/HTTP，扩展来拉（本方案）

本方案选择 **HTTP Bridge + 扩展长轮询**，更易诊断、易跨语言。

## 控制面
- Bridge：命令队列、结果等待、doctor
- Extension：tab/tabGroups/scripting/screenshot
- CLI/Skill：面向 Agent 的稳定接口

## 与 Codex 对齐的语义
- `openTabs`
- `claimTab` / `claimCurrentTab`
- `startTask` / `endTask` + tab group
- 页面操作后返回结构化 JSON

## 非目标（v0.1）
- 不实现完整 Playwright 选择器引擎（先 CSS/text/index）
- 不实现跨浏览器（仅 Chrome）
- 不默认清理用户其他标签
