# FigRig

让 AI Agent 通过本地 CLI 读写 Figma 画布、制作可交互原型。无需 Figma 付费订阅，免费版即可。

## 它是什么

一条本地链路：

```
AI Agent → figrig CLI → localhost WebSocket → Figma 插件 → Plugin API
```

- Agent 只表达操作意图（inspect / create / edit-layout / edit-style / vector / review / prototype）
- CLI 按固定映射把画布数据组装成对应格式，Agent 不需要在多种数据格式间做选择
- 写完自动读回校验；操作带幂等 ID；插件中断时保留不确定状态、禁止盲目重放

## 设计要点

- **确定性优先**：用节点 ID 和精确数值操作，不依赖截图猜坐标
- **四种数据表示按需路由**：精简 JSX（理解）、原始值 JSON（精确编辑）、SVG（形状）、PNG（审美）
- **本地优先**：全程 localhost，无 REST API 限流

## 状态

开发中（Windows 优先，Node.js 20+）。详见实施计划。

## 安装

```bash
npm install
npm start        # 启动 relay，监听 ws://127.0.0.1:3055
```

## 第 1 步链路

```bash
node cli.mjs bind "https://www.figma.com/design/<fileKey>/<名称>?node-id=1-2"
node cli.mjs connect --channel demo --fileKey <fileKey>
```

- `bind` 解析 fileKey 与 node-id（`1-2` 归一为 `1:2`），写入 `.figrig/binding.json`
- `connect` 以 channel 成员身份挂起；后续命令携带的 fileKey 与绑定值不一致时报错
- 插件：Figma 中导入 `plugin/manifest.json`，运行后在 UI 填入同一 channel 并连接

## 许可证

Apache-2.0
