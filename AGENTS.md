# stable-chrome

任意 Agent 安装（一句话）：在仓库根目录执行 `python3 cli/sbc setup`（Windows 用 `python cli\sbc setup`），然后请用户在打开的 Chrome 扩展页开启开发者模式，加载已解压扩展，目录为输出里的 `extensionDir`。用同一条 CLI 跑 `doctor`，看到 `extension.online=true` 后再操作真实 Chrome。禁止 `--remote-debugging-port=9222`。

用法见 `skill/SKILL.md`。
