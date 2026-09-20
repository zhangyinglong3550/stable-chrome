# stable-chrome 协议 v1

## 传输

- CLI → Bridge：`HTTP JSON` `http://127.0.0.1:19527`
- Extension → Bridge：`HTTP JSON` 同一端口
- Bridge **不**主动连扩展；扩展周期性 `poll` 拉取命令并 `post` 结果

## CLI / Agent 调用 Bridge

### `GET /health`
```json
{ "ok": true, "bridge": true, "extensionOnline": true, "lastSeenMs": 1200 }
```

### `GET /doctor`
完整诊断信息。

### `POST /cmd`
请求：
```json
{
  "type": "openTabs",
  "timeoutMs": 15000,
  "params": {}
}
```

响应：
```json
{ "ok": true, "id": "cmd_xxx", "result": { ... } }
```
失败：
```json
{ "ok": false, "id": "cmd_xxx", "error": "..." }
```

## Extension 与 Bridge

### `POST /ext/hello`
扩展上线注册。

### `GET /ext/poll?waitMs=25000`
长轮询取下一条待执行命令：
```json
{ "ok": true, "cmd": { "id": "cmd_xxx", "type": "openTabs", "params": {} } }
```
无命令：
```json
{ "ok": true, "cmd": null }
```

### `POST /ext/result`
```json
{ "id": "cmd_xxx", "ok": true, "result": { ... } }
```
或
```json
{ "id": "cmd_xxx", "ok": false, "error": "..." }
```

## 命令类型

| type | 说明 |
|---|---|
| `ping` | 心跳 |
| `openTabs` | 列出可见标签 |
| `claimTab` | 接管指定 tabId，并设为任务根 |
| `claimCurrentTab` | 接管当前活动标签 |
| `startTask` | 开始任务（建/更新分组） |
| `endTask` | 结束任务（可选解散分组） |
| `setGroupTitle` | 改任务分组标题 |
| `newTab` | 新开标签（默认进任务分组） |
| `goto` | 导航 |
| `reload` | 刷新 |
| `click` | 点击。`params` 支持 `node`（稳定编号，推荐）/ `index`（与 snapshot 一一对应）/ `selector` / `text`；`trusted: true` 走 CDP 可信输入并前置标签 |
| `fill` | 输入。`params` 同样支持 `node` / `index` / `selector`；对 checkbox / radio 会明确拒绝并提示改用 `click`。返回值含 `stale` / `staleFields` / `contextChanged` |
| `press` | 按键 |
| `eval` | 执行 JS，返回 JSON 可序列化结果 |
| `snapshot` | 可见可交互元素列表。每项含 `node`（跨快照稳定）、`index`、`role`、`name`（可访问名称）、`value`/`checked`/`selectedValue`/`expanded` 等状态、`selector`、坐标、`guard`（元素指纹）；`role: "option"` 的条目代表原生下拉的一个未选中选项，带 `parentNode`。顶层含 `marker`（页面指纹）、`pageText`（视口内文本）、`scroll`（滚动状态）、`omitted`（被 max 截断的数量） |
| `screenshot` | 截图（返回文件路径或 base64） |
| `waitFor` | 等待选择器 / 文本 |
| `content` | 读取标题/URL/正文摘要 |

## 元素编号与页面缓存

`snapshot` 会在页面的**扩展隔离世界**（ISOLATED world）上维护一份元素缓存：

- `ids`：`WeakMap`，给每个 DOM 节点分配跨快照稳定的 `node` 编号；节点被回收后自动释放
- `nodes`：`Map`，`node` → 元素，供 `click --node` 直接取回，**不重新查询页面**

缓存挂在 `window.__sbcScan`，但只存在于扩展的隔离世界：`snapshot` / `click` 走 `chrome.scripting.executeScript`（默认隔离世界），而 `sbc eval` 走 `world: 'MAIN'`，**两者看不到彼此的全局变量**。这是有意为之——页面脚本无法读写这份缓存。所以用 `sbc eval` 查 `window.__sbcScan` 会得到 `undefined`，属正常现象。

因为 `click` 与 `snapshot` 共用同一个采集函数（`scanPage`），`--index` 与 `snapshot` 的 `index` 严格一一对应。缓存随页面导航失效，重新 `snapshot` 即可重建。

## 点击的可信输入

`click` 默认派发合成鼠标事件（后台标签可用，不抢焦点）。传 `trusted: true` 时改走 CDP `Input.dispatchMouseEvent`，事件带 `isTrusted=true`，用于校验事件可信度的站点。

**注意**：后台标签收不到 CDP 的 `mousePressed`（只收得到 `mouseMoved`），所以可信模式会先 `Page.bringToFront` 把标签提到前台。这是 Chrome 的既定行为。

## 原生下拉（select）

`scanPage` 会把每个「未选中且未禁用」的 `<option>` 展开成一条 `role: "option"` 的条目，带 `parentNode`（所属 select 的 node）和 `value`。

`click` 命中 option 时**不派发鼠标事件**（原生下拉的选项不在普通命中测试里），而是映射成给父 select 赋值 + 派发 `input`/`change`，返回 `via: "select"`、`previousValue`、`value`。父 select 已被移除时返回 `parent select is gone; re-run snapshot`。

## 动作后的等待与变化判定

`click` 在动作后会调用 `waitForSettle`：先等 60ms 看有没有 DOM 变动，有就提前返回，没有再把剩余时间等满（`settle` 默认 120ms，`settle: 0` 关闭）。

**计时刻意放在扩展侧**：页面里的 `setTimeout` 在后台标签会被 Chrome 节流到约 1 秒，用它做轮询会把 120ms 的等待拖成 800ms+。页面里只装一个 `MutationObserver`（挂在 `window.__sbcMut`）记录变动次数，由扩展侧 `sleep` 控制节奏。

这让 `changed` 对异步渲染的站点也基本可靠。`changed` 的指纹包含 URL、标题、节点数、可见文本长度、滚动位置**和所有表单值**——后者是必须的，因为 select/checkbox 的改动不改变前几项。返回里的 `settleMs` 是实际等待毫秒数，`settleSawMutation` 表示期间是否观察到变动。

## 约定

- `tabId` 一律字符串
- 扩展离线超过 8s → `extensionOnline=false`
- 命令默认超时 20s
- 不允许静默 fallback 到匿名浏览器
