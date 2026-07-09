# stable-chrome

独立于 Codex 的 **Chrome 扩展附着** 浏览器自动化能力。

目标体验对齐 Codex `@chrome`：

- 附着用户**真实 Chrome**（复用登录态）
- **不依赖** `--remote-debugging-port=9222`（绕过 Chrome 136+ 默认 profile 限制）
- 为每个任务创建 **独立标签分组**
- 用 DOM 级 API 操作（click/fill/eval），不是截图点点点

## 架构

```text
Claude Skill / CLI (sbc)
        │  HTTP  http://127.0.0.1:19527
        ▼
Bridge Server（本地常驻）
        │  命令队列 + 响应通道
        ▼
Chrome Extension（MV3）
  · chrome.tabs / tabGroups / scripting / debugger
        ▼
用户真实 Chrome（登录态、Cookie、已开标签）
```

## 快速开始

```bash
cd ~/code/stable-chrome
./scripts/install.sh
./scripts/doctor.sh
./scripts/start-bridge.sh

# 在 Chrome 打开 chrome://extensions
# 1) 开启「开发者模式」
# 2) 「加载已解压的扩展程序」→ 选择本仓库 extension/
# 3) 复制扩展 ID，执行：
./scripts/install-native-host.sh <EXTENSION_ID>

# 验证
./cli/sbc doctor
./cli/sbc open-tabs
./cli/sbc start-task --title "demo"
./cli/sbc new-tab --url "https://example.com"
./cli/sbc eval "document.title"
```

## 目录

```text
stable-chrome/
  extension/     Chrome MV3 扩展
  bridge/        本地 HTTP 桥接服务
  cli/sbc        命令行入口
  scripts/       安装 / 诊断 / 启动
  skill/         Claude Code skill
  docs/          协议与设计
```

## 设计原则

1. **扩展桥优先**，CDP/9222 永不作为主路径
2. 失败要硬报错，禁止静默降级到匿名浏览器
3. 自动化标签必须进任务分组，隔离日常浏览
4. 所有操作可被 doctor 诊断
