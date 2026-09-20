---
name: stable-chrome
description: 稳定附着用户真实 Chrome（不依赖 9222），支持 openTabs/claim/任务标签分组/DOM 操作。用户要安装/setup/加载扩展、或控制真实 Chrome / 复用登录态 / 9222 失败时：先在仓库根目录运行 python3 cli/sbc setup（Windows: python cli\sbc setup），再让用户加载 extension/。
---

# stable-chrome

独立于 Codex 的真实 Chrome 附着能力。任意 Agent 都走同一条安装命令，不限于 Claude Code。

## 架构一句话
CLI/Agent → 本地 Bridge(`http://127.0.0.1:19527`) → Chrome 扩展 poll 命令 → 在真实标签上执行。

## 安装（Agent 先做这个）
在仓库根目录执行（用户不用自己跑脚本）：

```bash
python3 cli/sbc setup          # Windows: python cli\sbc setup
```

`setup` 会拷 skill、起 Bridge、打开 `chrome://extensions`。Chrome **禁止**静默安装未打包扩展，所以还要请用户：开发者模式 → 加载已解压 → 输出里的 `extensionDir`。然后：

```bash
python3 cli/sbc doctor         # Windows: python cli\sbc doctor
```

`extension.online=true` 再继续操作。不要让用户执行 `install.sh`。

## 前置
1. 已跑过 `sbc setup`（或 Bridge 已在 `http://127.0.0.1:19527`）
2. Chrome 已加载仓库内 `extension/` 目录
3. `sbc doctor` 显示 `extension.online=true`

## 推荐工作流
```bash
sbc doctor
sbc open-tabs
# 同会话只 start-task 一次；默认独立后台窗口，不和用户抢同一窗
sbc start-task --title "部署任务"
sbc new-tab --url "https://example.com"   # 同任务默认永远单标签（后台）
sbc new-tab --url "https://example.com/next"  # 再次调用 = 同标签导航，不新开
# 等价写法：sbc goto "https://example.com/next"
# 真要第二页：sbc new-tab --url "..." --force
sbc snapshot                              # 拿到每个元素的 node 编号
sbc click --node 12                       # 用编号点击（最稳，推荐）
sbc fill --selector "input[name=user]" --value "xxx"
sbc screenshot --out /tmp/a.png           # 优先 CDP 截图，不切用户标签
sbc end-task
```

## 怎么选点击方式（按稳定性排序）

1. **`--node N`（推荐）**：编号来自 `snapshot`，跨快照稳定，页面重排也不会点错
2. **`--index N`**：与 `snapshot` 的 `index` 字段严格一一对应（同一次采集逻辑）
3. **`--selector`**：CSS 选择器，取第一个匹配
4. **`--text "..."`**：按可见文字全等/包含匹配，重名元素时不可靠

**点击会自动拒绝两种情况**并说明原因：目标被遮挡（`target is covered by <div>`）、目标是 disabled。
返回里的 `changed` 表示动作后 URL/标题/节点数/文本长度是否变化——异步渲染的站点可能返回 `false`，需要自己 `sbc wait` 再确认。

**`stale` 是正确率的关键信号**：快照时会给每个元素记下指纹，点击/输入前重算比对。如果元素自身属性（`name` / `value` / `checked` / `disabled` 等）变了，返回 `stale: true` 和 `staleFields`——**说明你要操作的可能已经不是当初看到的那个元素，应该重新 `snapshot` 再决定**。只是邻近上下文文字变了则报 `contextChanged`，一般可以忽略。

**`changed` 现在会等页面稳定再判断**：动作后最多等 `--settle`（默认 120ms），一旦观察到 DOM 变动就再等两帧返回。所以对异步渲染的站点也基本可靠。返回里的 `settleMs` 是实际等了多久，`settleSawMutation` 表示期间有没有观察到变动。`--settle 0` 可关闭等待（更快，但 `changed` 会退回成不可靠的启发式）。

`--trusted` 走 CDP 真实输入（`isTrusted=true`），用于校验事件可信度的站点；**代价是会把这个标签提到前台**。默认用合成事件，不抢焦点。

## 命令速查
| 命令 | 作用 |
|---|---|
| `sbc setup` | 装 skill、起 Bridge、打开扩展页（任意 Agent 的安装入口） |
| `sbc health` | bridge 健康 |
| `sbc doctor` | 扩展是否在线 |
| `sbc open-tabs` | 列出真实标签 |
| `sbc claim [--tab-id] [--window]` | 接管标签并建任务组；`--window` 拆到独立后台窗 |
| `sbc start-task [--title]` | 开始/复用任务组；**默认独立后台窗**；`--same-window` 才同窗 |
| `sbc new-tab --url` | 同任务默认单标签：有 claimed 则导航复用；`--force` 才新建第二页 |
| `sbc close-tab [--tab-id]` | 关闭标签（默认可关当前 claimed） |
| `sbc goto URL` | 在已 claim 标签上导航（与默认 new-tab 等价） |
| `sbc click --node|--index|--selector|--text` | 点击；`--node` 最稳，`--trusted` 走 CDP 可信输入（会前置标签），`--settle MS` 调动作后的等待 |
| `sbc fill --node|--index|--selector --value` | 输入；和 `click` 一样支持 `--node` 定位。checkbox/radio 请用 `click` 切换 |
| `sbc eval 'document.title'` | 执行 JS |
| `sbc snapshot [--max N]` | 可见可交互元素，含稳定编号/可访问名称/元素状态 |
| `sbc decide --goal "..."` | 可选决策层：有 `TYPESAFE_API_KEY` 时用 JEV 选下一步操作+目标；没有则返回编号表交回调用方决策 |
| `sbc content` | 读正文摘要 |
| `sbc cookie-get [--name NAME] [--url URL]` | 读 cookie（**含 HttpOnly**，走 CDP，不需要 cookies 权限）；输出含明文值 |
| `sbc wait --text|--selector` | 等待 |
| `sbc screenshot --out` | 截图（优先 CDP `Page.captureScreenshot`，不切标签；失败才降级） |
| `sbc end-task [--close-group] [--close-tabs]` | 结束任务；默认分组和标签都保留，`--close-group` 解散分组（标签散落回窗口），`--close-tabs` 真正关闭组内页面 |
| `sbc net-start [--tab-id]` | 开始 CDP 网络捕获 |
| `sbc net-get [--tab-id] [--grep STR]` | 读取捕获的 API 请求（不停止） |
| `sbc net-stop [--tab-id] [--grep STR]` | 停止捕获并输出所有请求 |

## snapshot 输出字段

```json
{
  "url": "...", "title": "...",
  "count": 10, "omitted": 0,      // omitted>0 说明还有元素没列出来，调大 --max
  "marker": "...",                 // 页面指纹
  "pageText": "...",               // 视口内可见文本（上限 4000 字），当页面上下文用
  "scroll": { "y": 0, "height": 934, "viewport": 934,
              "canScrollUp": false, "canScrollDown": false },
  "items": [{
    "node": 12,            // 跨快照稳定的编号，click --node 用它
    "index": 3,            // 本次快照内的位置，click --index 用它
    "role": "button",      // 归一化角色：button/link/checkbox/combobox/textbox/option...
    "name": "关闭对话框",   // 可访问名称，按 aria-labelledby → aria-label → label → 文本 → img alt → title → placeholder 取值
    "text": "✕",           // 可见文字
    "value": "", "href": null, "placeholder": null,
    "selector": "#close",  // 兜底用；无 id/name 时会带 role+aria-label，不再退化成裸 tag
    "disabled": false, "readOnly": false,
    "checked": true,       // checkbox/radio 专有
    "selectedValue": "b",  // select 专有
    "expanded": "true",    // aria-expanded 等状态按需出现
    "x": 100, "y": 200, "width": 38, "height": 36,
    "guard": "..."         // 元素指纹，用于判断元素是否还是决策时的那个
  }]
}
```

**原生下拉的每个「未选中且未禁用」选项会单独成一条**，`role: "option"`，带 `parentNode`（所属 select 的 node）和 `value`。直接 `click --node <选项的node>` 就能选中——内部会映射成给父 select 赋值，不走鼠标事件。

**已经过滤掉的**（不会出现在结果里）：`disabled` / `aria-disabled` 元素、`display:none` / `visibility:hidden` / `opacity:0` / `aria-hidden` / `inert` 元素、小于 5px 的元素、视口外的元素。

**兜底采集**：很多现代前端框架的自定义下拉/菜单是纯 `div`/`span`、**不带任何 `role`**，只按 role 采集会整片漏掉。扫描器会补扫一轮「`cursor: pointer` + 叶子节点」的元素，标记成 `role: "clickable"` 并带 `heuristic: true`。

**看到 `heuristic: true` 就要按启发式对待**——它们是靠样式猜出来的可点元素，不像 `button`/`link` 那样有明确语义。数量有硬上限（单次最多 20 个，扫描节点数上限 3000），不会因为页面巨大而拖慢。

**只收录视口内的元素**——想操作页面下方的元素，先看 `scroll.canScrollDown`，需要时 `sbc eval 'window.scrollBy(0,600)'` 再快照。

## 决策层（可选）

`sbc decide --goal "..."` 把「下一步点哪里」从「大模型写选择器」换成「在封闭选项里选一个」。

**它是可选的加速器，不是依赖**：

```bash
# 配了 TYPESAFE_API_KEY：走 JEV，返回 operation + targetNode + 置信度
sbc decide --goal "点击登录按钮"

# 没配：把本该喂给决策器的编号表原样交回，exit code 2
sbc decide --goal "点击登录按钮"
```

没有 key 时的输出长这样——**不是报错，是给你一份可以直接决策的输入**：

```json
{
  "ok": false,
  "decider": null,
  "reason": "TYPESAFE_API_KEY 未设置，没有可用的 JEV 决策器",
  "hint": "用你自己的 LLM 在下面这份 elements 编号表上决策，然后执行 sbc click --node <node>",
  "goal": "...",
  "page": { "url": "...", "title": "...", "text": "视口内文本" },
  "elements": { "e11": { "node": 11, "role": "button", "name": "正常按钮", ... } }
}
```

有 key 时返回：

```json
{
  "ok": true, "decider": "jev", "model": "jev-1.13.0",
  "operation": "CLICK",              // CLICK | TYPE_TEXT | SCROLL_UP | SCROLL_DOWN | WAIT | DONE
  "operationConfidence": 0.99,
  "targetNode": 11, "targetName": "正常按钮", "targetConfidence": 1.0,
  "latencyMs": 1510, "usage": { "input_tokens": 1008, "output_tokens": 145 }
}
```

拿到 `targetNode` 后执行 `sbc click --node <targetNode>`；`operation` 是 `TYPE_TEXT` 时返回 `needsText: true`——**决策器只选目标，文字由调用方提供**（JEV 不生成文本）。

**为什么要这样设计**：有 JEV 和没 JEV 的人用同一套工具、同一套下游（都走 `click --node`），只是决策速度不同。哪天拿到 key，加一个环境变量就生效，调用方代码不用改。

调用的两个约定：一次请求同时问 `operation` / `click_target` / `type_target`（并行返回，猜错的分支直接忽略，不浪费往返）；选项基数上限 200（JEV 的 Choice 上限是 255，超过要走两阶段打分）。

## 任务生命周期（分组什么时候关）

**默认永不自动关闭** —— Agent 不该静默关掉用户可能还要看的页面。要关，必须满足「确定完成」：

推荐约定（配合决策层）：

| 阶段 | 动作 |
|---|---|
| 开任务 | `sbc start-task`（建分组） |
| 每步 | `sbc snapshot` → `sbc decide` → 按 `recommendedAction` 执行 |
| decide 返回 `DONE` 且 gate=high | **先独立验证**——检查页面上真的出现了目标状态。模型说完成不算数 |
| 验证通过 | `sbc end-task --close-group`（解散分组，标签保留） |
| 页面只是手段、确定没用了 | `sbc end-task --close-tabs`（真正关闭组内页面，分组随之消失） |

**两类任务要区分**：

- **手段型**（页面只是工具：查个数、点个按钮、填个表单）→ 完成后 `--close-tabs` 合理
- **交付型**（页面本身就是结果：仪表盘、调试环境、留给用户看的页面）→ **永远不要自动关**

就算忘了收尾也无妨——分组积累不影响任何功能，定期人工清理即可。

## 硬规则

1. **禁止**默认使用 9222 / 复制 profile / 匿名 Chromium 冒充连接成功
2. 扩展离线时：先 `sbc setup`（或确认 Bridge + 扩展已加载），再重试
3. 自动化页面必须进任务标签分组，减少干扰用户日常浏览
4. 内网登录页：优先 `claim` 用户已登录标签，不要新开匿名页硬登
5. **默认不抢浏览器焦点**：`claim` / `start-task` / `new-tab` / `goto` 均静默后台执行；只有显式 `--focus` / `--active` 才前置窗口。
6. **`start-task` 默认独立窗口**（unfocused）：Agent 与用户分窗；只有用户明确要求同窗时才用 `--same-window`。
7. **截图默认不切标签**：优先 `chrome.debugger` → `Page.captureScreenshot`；仅 CDP 失败时才短暂 `captureVisibleTab` 并恢复。
8. 新建任务标签分组颜色从 8 色里**随机**取（`title + 时间戳 + 随机数` 做 hash），不保证并存的多个分组颜色互不相同；要固定色用 `start-task --color green`。复用已有分组不覆盖颜色
9. **同会话复用**：`start-task` 可重复调用，状态跨扩展 SW 重启持久化；不要为每个子步骤再 `start-task` 一套
10. **同任务永远单标签**：`new-tab` 默认 = 导航复用 claimed 标签；只有显式 `--force` 才开第二页
11. **不收养用户工作区分组**：`claim` / `start-task` 不会把你已有的标签组改名成任务组；会把目标标签拆出单独建 Agent 组
12. **`click` 默认不抢焦点**：合成事件在后台标签可用；只有显式 `--trusted` 才走 CDP 并把标签提到前台。后台标签收不到 CDP 的 `mousePressed`，这是 Chrome 的行为，不是 bug

## Agent 用法注意
- 一次会话：`start-task` 一次（默认独立窗）→ 反复 `new-tab --url` 只会在同一标签跳转
- 不要加 `--same-window`，除非用户明确要求在当前窗口操作
- 真要并行两个页面：`sbc new-tab --url ... --force`
- 开页请用 `sbc new-tab --url ...`（默认后台），**不要**加 `--active` 除非用户要求看页面
- 不要 `claim --focus`，除非用户明确说「切到这个标签」
- **不要 claim 用户正在工作的标签**，除非用户明确要求接管；优先 `start-task` + `new-tab`
- 任务组标题默认 `Agent 任务`；需要语义化时传 `--title "部署任务"` 等
- 任务组颜色：省略则自动随机；需要固定色用 `--color`
- 截图结果里 `method: "debugger"` 表示无焦点干扰；若落到 `captureVisibleTab` 才可能闪一下

## 故障排查
```bash
sbc doctor
# 看 extension.online / hints
# 扩展 service worker 控制台应持续请求 /ext/poll
# 改完 extension 后：sbc reload-extension（或 chrome://extensions 点重新加载）
# 未安装：python3 cli/sbc setup
```

**所有命令超时、但 doctor 显示扩展在线**  
轮询循环卡死了（心跳还在发，但不再取命令——`/doctor` 里 `queueSize` 会持续增长）。重载扩展即可恢复；**v0.2.0 起内置停滞看门狗，卡住 60 秒自动换新轮询循环，无需人工干预**。

## 实现路径
安装后在仓库根目录找到对应文件：
- 安装入口：`python3 cli/sbc setup`（Windows：`python cli\sbc setup`）
- CLI：`cli/sbc`
- Bridge：`bridge/server.py`
- Chrome 扩展：`extension/`
- Agent 入口：`AGENTS.md`
