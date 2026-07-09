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
| `click` | 点击 CSS 选择器 / 文本 |
| `fill` | 输入 |
| `press` | 按键 |
| `eval` | 执行 JS，返回 JSON 可序列化结果 |
| `snapshot` | 可见可交互元素列表 |
| `screenshot` | 截图（返回文件路径或 base64） |
| `waitFor` | 等待选择器 / 文本 |
| `content` | 读取标题/URL/正文摘要 |

## 约定

- `tabId` 一律字符串
- 扩展离线超过 8s → `extensionOnline=false`
- 命令默认超时 20s
- 不允许静默 fallback 到匿名浏览器
