# FigRig

本地运行的操作链路：AI Agent 经 CLI 提交操作意图，本地 relay 经 WebSocket 转发至 Figma 插件，插件调用 Figma Plugin API 执行节点读写与原型关系写入，并回读结果形成校验闭环。链路全程运行于 localhost，不依赖 Figma REST API 与付费订阅。

## 工作原理

```
AI Agent
   ↓ CLI（命令含操作意图枚举）
figrig CLI（Node.js，不依赖 Bun）
   ↓ WebSocket localhost:3055（channel 隔离）
relay（本地消息转发）
   ↓
Figma 插件（ui.html iframe 持有 WebSocket，main.js 调用 Plugin API）
   ↓
Figma Plugin API（节点读写 / exportAsync / 原型关系 reactions）
```

意图与格式分离：Agent 仅声明操作意图（inspect / create / edit-layout / edit-style / vector / review / prototype），CLI 按固定映射组装数据格式。每个操作携带 UUID v4 格式 requestId，重投且内容逐字段一致时返回 reused；写入后自动读回断言核验；回执丢失时任务标记为不确定状态，经 recover 独立核验，不自动重放。

## 前提与限制

- 本地优先：relay 监听 `ws://127.0.0.1:3055`，插件沙箱内 iframe 持有 WebSocket 连接；无 token、无 REST 限流。
- Figma 免费版可用：链路仅使用 Figma Plugin API，不依赖付费订阅。
- Node.js 20+，纯 JavaScript ES Modules，不依赖 Bun。
- 真机端到端尚未由作者验证：插件在真机 Figma 内的行为以桩节点环境校验（测试输出标注 `visual: not-run`）；原型关系写入后需在 Figma Present 模式人工点击验证。
- 触发器首版仅支持 `click`（映射 Figma `ON_CLICK`）。

## 安装

```bash
git clone https://github.com/TEXXXXTURE/figrig.git
cd figrig
npm install
npm start        # 启动 relay，监听 ws://127.0.0.1:3055
```

插件：Figma 菜单 Plugins → Development → Import plugin from manifest…，选择 `plugin/manifest.json`。运行 FigRig 插件，在 UI 填入与 CLI 一致的 channel 后 connect。

CLI 连接：

```bash
node cli.mjs bind "https://www.figma.com/design/<fileKey>/<名称>?node-id=1-2"
node cli.mjs connect --channel demo --fileKey <fileKey>
```

- `bind` 解析 fileKey 与 node-id（`1-2` 归一为 `1:2`），写入 `.figrig/binding.json`
- `connect` 以 channel 成员身份挂起；后续命令携带的 fileKey 与绑定值不一致时报错

## 命令清单

| 命令 | 最小示例 | 说明 |
|---|---|---|
| bind | `node cli.mjs bind "https://www.figma.com/design/<fileKey>/<名称>?node-id=1-2"` | 解析 Figma 链接并写入绑定 |
| read | `node cli.mjs read --intent inspect --nodeId 1:2` | 按意图路由格式读取节点（inspect→jsx，create/edit-layout/edit-style/prototype→json，vector→svg，review→png） |
| expand | `node cli.mjs expand --nodeId 1:2` | 读取指定子树完整属性 |
| write | `node cli.mjs write --op create-frame --parentId 1:1 --params '{"name":"Panel","width":320,"height":200}' --expect name=Panel` | 写入节点并断言核验 |
| review | `node cli.mjs review --nodeId 1:2` | 导出 PNG 至 `.figrig-run/images`，上下文仅保留路径 |
| recover | `node cli.mjs recover --requestId <uuid>` | 对不确定任务独立核验，不重放 |
| component-add | `node cli.mjs component-add --name Button --nodeId 1:9 --confirm` | 登记组件模板 |
| component-list | `node cli.mjs component-list` | 列出注册表条目 |
| component-use | `node cli.mjs component-use --name Button --parentId 1:10` | 按模板在新父节点复放 |
| prototype | `node cli.mjs prototype --file proto.json` | 写入原型关系并读回断言 |

非法意图、非法 trigger/action 枚举直接报错，不推断。

## 原型 JSON schema 与差异式语义

命令：`node cli.mjs prototype --file <json>`（或 `--json '<json>'`）。schema 固定：

```json
{
  "links": [
    { "from": "1:2", "trigger": "click", "action": "navigate", "to": "1:3" },
    { "from": "1:4", "trigger": "click", "action": "overlay", "to": "1:5" },
    { "from": "1:6", "trigger": "click", "action": "scroll", "to": "1:7" },
    { "from": "1:8", "trigger": "click", "action": "back" }
  ]
}
```

- `trigger` 首版仅 `click`（映射 `ON_CLICK`）。`action` 枚举：`navigate`（`{type:"NODE", destinationId, navigation:"NAVIGATE"}`，页面跳转）、`overlay`（`{type:"OVERLAY", overlayId}`，弹层）、`scroll`（`{type:"SCROLL_TO", destinationId}`，容器内滚动定位）、`back`（`{type:"BACK"}`，返回上一屏，省略 `to`）。非法枚举报错，不推断；非 back 动作缺 `to` 或目标节点不存在报错。
- 差异式：`links` 仅列需要设置的关系，多屏只给变化项；`links` 中未出现的 from 节点不受影响。
- 整体替换：同一 from 节点按本次输入整体替换其 reactions，不做增量合并。
- 断言（FR-11）：执行后读回每个 from 节点 reactions，逐条比对 trigger 类型、action 类型、destinationId/overlayId，全部命中为成功；失败报错，不静默成功。

## 项目结构

```
cli.mjs             CLI 入口：命令路由、幂等包裹、断言核验
relay.mjs           本地 WebSocket 转发服务
plugin/main.js      Figma 插件主线程：节点读写、原型关系、图片导出
plugin/ui.html      iframe UI：持有 WebSocket 连接
plugin/manifest.json 插件清单（networkAccess 限定 localhost:3055）
formats/            意图路由与格式转换（jsx/json/svg/png）
assert.mjs          断言解析与求值
ops.mjs             写入操作枚举与预期断言推导
prototype.mjs       原型链接解析与读回断言核验
task-store.mjs      任务记录与幂等判定
recover.mjs         故障恢复核验
registry.mjs        组件注册表与模板复放
test/verify.mjs     桩节点校验（路由、转换器、写入、原型、幂等、恢复、注册表）
test/e2e.mjs        端到端校验（真实 relay + 桩插件，输出 visual: not-run）
```

## 校验

```bash
npm run check      # 全部 js/mjs 语法检查
npm run verify     # 桩节点校验
npm run e2e        # 端到端校验（真实 relay + 桩插件）
```

## License

Apache-2.0
