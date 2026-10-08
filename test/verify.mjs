// 校验脚本：意图路由、格式转换器、节点计数上限、渐进披露字段范围。
// 桩节点驱动；插件在 Figma 沙箱内的真机行为属外部验证项，此处以 vm 加载 plugin/main.js 校验其逻辑。

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';

import { INTENTS, selectFormat } from '../formats/index.mjs';
import { convert as toJsx } from '../formats/jsx.mjs';
import { convert as toJson } from '../formats/json.mjs';
import { convert as toSvg } from '../formats/svg.mjs';
import { convert as toPng } from '../formats/png.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function section(title) {
  console.log(`\n===== ${title} =====`);
}

function flatten(node, list = []) {
  list.push(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) flatten(child, list);
  }
  return list;
}

function solid(hex, rgba, color) {
  return { type: 'SOLID', visible: true, opacity: 1, hex, rgba, color };
}

// 桩树：Frame×3、Text×2、Rectangle×1，含填充与 Auto Layout 属性。
function buildStub() {
  const title = {
    id: '1:3', name: 'Title', type: 'TEXT',
    x: 32, y: 32, width: 120, height: 20,
    characters: 'Hello', fontSize: 14,
  };
  const swatch = {
    id: '1:4', name: 'Swatch', type: 'RECTANGLE',
    x: 160, y: 32, width: 64, height: 64,
    fills: [solid('#7C3AED', 'rgba(124, 58, 237, 1)', { r: 0.486, g: 0.227, b: 0.929, a: 1 })],
  };
  const row = {
    id: '1:2', name: 'Row', type: 'FRAME',
    x: 24, y: 24, width: 224, height: 64,
    layoutMode: 'HORIZONTAL', itemSpacing: 8,
    paddingLeft: 8, paddingRight: 8, paddingTop: 8, paddingBottom: 8,
    children: [title, swatch],
  };
  const caption = {
    id: '1:5', name: 'Caption', type: 'TEXT',
    x: 24, y: 96, width: 224, height: 16,
    characters: 'World', fontSize: 12,
  };
  const spacer = {
    id: '1:6', name: 'Spacer', type: 'FRAME',
    x: 24, y: 120, width: 224, height: 40,
    layoutMode: 'VERTICAL', itemSpacing: 0,
    paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
    children: [],
  };
  const root = {
    id: '1:1', name: 'Card', type: 'FRAME',
    x: 0, y: 0, width: 272, height: 184,
    layoutMode: 'VERTICAL', itemSpacing: 16,
    paddingLeft: 24, paddingRight: 24, paddingTop: 24, paddingBottom: 24,
    fills: [solid('#FFFFFF', 'rgba(255, 255, 255, 1)', { r: 1, g: 1, b: 1, a: 1 })],
    children: [row, caption, spacer],
  };
  return root;
}

// 宽树：root + (total - 1) 个子节点。
function buildBulk(total) {
  const root = { id: '9:1', name: 'Bulk', type: 'FRAME', children: [] };
  for (let i = 2; i <= total; i += 1) {
    root.children.push({ id: `9:${i}`, name: `N${i}`, type: 'FRAME', children: [] });
  }
  return root;
}

// 以桩 figma 全局加载 plugin/main.js，捕获 postMessage 回包。
function loadPlugin(registry) {
  let resolver = null;
  const posts = [];
  const figma = {
    fileKey: 'stub-file',
    apiVersion: '1.0',
    editorType: 'figma',
    root: { name: 'Stub' },
    showUI() {},
    ui: {
      onmessage: null,
      postMessage(message) {
        posts.push(message);
        if (resolver) {
          const settle = resolver;
          resolver = null;
          settle(message);
        }
      },
    },
    async getNodeByIdAsync(id) {
      return registry.has(id) ? registry.get(id) : null;
    },
  };
  const context = createContext({ figma, __html__: '<html></html>', console });
  const source = readFileSync(resolve(ROOT, 'plugin', 'main.js'), 'utf8');
  runInContext(source, context, { filename: 'plugin/main.js' });
  return {
    posts,
    send(message) {
      return new Promise((settle, reject) => {
        const timer = setTimeout(() => {
          resolver = null;
          reject(new Error(`no response for ${message.type}`));
        }, 5000);
        resolver = (value) => {
          clearTimeout(timer);
          settle(value);
        };
        figma.ui.onmessage(message);
      });
    },
  };
}

function assertOverviewShape(node) {
  assert.deepEqual(Object.keys(node).sort(), ['children', 'id', 'name', 'type']);
  assert.ok(Array.isArray(node.children), 'children 必为数组');
  for (const child of node.children) assertOverviewShape(child);
}

async function main() {
  const stub = buildStub();
  const registry = new Map(flatten(stub).map((node) => [node.id, node]));

  section('1. selectFormat 意图映射');
  const expected = {
    inspect: 'jsx',
    create: 'json',
    'edit-layout': 'json',
    'edit-style': 'json',
    vector: 'svg',
    review: 'png',
    prototype: 'json',
  };
  assert.deepEqual([...INTENTS].sort(), Object.keys(expected).sort());
  for (const [intent, format] of Object.entries(expected)) {
    const actual = selectFormat(intent);
    assert.equal(actual, format);
    console.log(`selectFormat(${intent}) -> ${actual}`);
  }

  section('2. selectFormat 非法意图');
  for (const bad of ['delete', 'INSPECT', '', undefined, null, 7]) {
    assert.throws(() => selectFormat(bad), /unknown intent/);
    console.log(`selectFormat(${String(bad)}) -> throws`);
  }

  section('3. SVG / PNG 占位模块');
  assert.deepEqual(toSvg(), { status: 'pending' });
  assert.deepEqual(toPng(), { status: 'pending' });
  console.log(`assert.deepEqual(svg.convert(), {status:'pending'}) -> ok`);
  console.log(`assert.deepEqual(png.convert(), {status:'pending'}) -> ok`);

  section('4. jsx.mjs 输出（桩树，含填充与布局）');
  const jsx = toJsx(stub);
  console.log(jsx);
  assert.match(jsx, /display:'flex'/);
  assert.match(jsx, /flexDirection:'column'/);
  assert.match(jsx, /gap:16/);
  assert.match(jsx, /padding:'24px 24px 24px 24px'/);
  assert.match(jsx, /backgroundColor:'#7C3AED'/);
  assert.match(jsx, /<span[^>]*>Hello<\/span>/);
  assert.match(jsx, /<div[^>]*id="1:6"[^>]*\/>/);
  assert.ok(!/Tailwind|slate|indigo|violet-600/.test(jsx), '不得出现 Tailwind 色名');
  console.log('assert: 布局映射、padding、色值原样内联、Text 文本节点、空 Frame 自闭合 -> ok');

  section('5. json.mjs 输出（桩树，字段白名单）');
  const json = toJson(stub);
  console.log(json);
  const parsed = JSON.parse(json);
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['children', 'fills', 'height', 'id', 'itemSpacing', 'layoutMode', 'name',
      'paddingBottom', 'paddingLeft', 'paddingRight', 'paddingTop', 'type', 'width', 'x', 'y'],
  );
  assert.equal(parsed.fills[0].hex, '#FFFFFF');
  assert.equal(parsed.children[0].children[1].fills[0].hex, '#7C3AED');
  assert.ok(!('bounds' in parsed) && !('absoluteBoundingBox' in parsed));
  console.log('assert: 白名单字段、fills 原始 hex/rgba、白名单外字段丢弃 -> ok');

  section('6. inspect overview（渐进披露：不含几何与填充）');
  const plugin = loadPlugin(registry);
  const overview = await plugin.send({ type: 'inspect', requestId: 'r-overview', nodeId: '1:1', mode: 'overview' });
  assert.equal(overview.type, 'inspect-result');
  assert.equal(overview.mode, 'overview');
  assert.equal(overview.count, 6);
  assertOverviewShape(overview.node);
  console.log(JSON.stringify(overview.node, null, 2));
  console.log(`assert: count=${overview.count}，每节点字段仅 id/name/type/children -> ok`);

  section('7. inspect full（expand：含几何、布局、填充、文本属性）');
  const full = await plugin.send({ type: 'inspect', requestId: 'r-full', nodeId: '1:1', mode: 'full' });
  assert.equal(full.type, 'inspect-result');
  assert.equal(full.mode, 'full');
  assert.equal(full.count, 6);
  const fullRoot = full.node;
  assert.equal(fullRoot.x, 0);
  assert.equal(fullRoot.y, 0);
  assert.equal(fullRoot.width, 272);
  assert.equal(fullRoot.height, 184);
  assert.equal(fullRoot.layoutMode, 'VERTICAL');
  assert.equal(fullRoot.itemSpacing, 16);
  assert.equal(fullRoot.paddingLeft, 24);
  assert.equal(fullRoot.paddingBottom, 24);
  assert.equal(fullRoot.fills[0].hex, '#FFFFFF');
  assert.equal(fullRoot.fills[0].rgba, 'rgba(255, 255, 255, 1)');
  const fullSwatch = fullRoot.children[0].children[1];
  assert.equal(fullSwatch.fills[0].hex, '#7C3AED');
  const fullText = fullRoot.children[0].children[0];
  assert.equal(fullText.characters, 'Hello');
  assert.equal(fullText.fontSize, 14);
  console.log(JSON.stringify(fullRoot, null, 2));
  console.log('assert: x/y/width/height、layoutMode、itemSpacing、padding*、fills(hex+rgba)、characters、fontSize -> ok');

  section('8. overview 与 full 字段差集');
  const overviewKeys = new Set(Object.keys(overview.node));
  const fullKeys = new Set(Object.keys(full.node));
  for (const key of ['x', 'y', 'width', 'height', 'layoutMode', 'itemSpacing', 'paddingLeft', 'fills']) {
    assert.ok(!overviewKeys.has(key), `overview 不应含 ${key}`);
    assert.ok(fullKeys.has(key), `full 应含 ${key}`);
  }
  console.log(`overview keys: ${[...overviewKeys].join(', ')}`);
  console.log(`full keys: ${[...fullKeys].join(', ')}`);

  section('9. 节点计数上限（2000）');
  const bulk2001 = loadPlugin(new Map(flatten(buildBulk(2001)).map((node) => [node.id, node])));
  const over = await bulk2001.send({ type: 'inspect', requestId: 'r-2001', nodeId: '9:1', mode: 'overview' });
  assert.equal(over.type, 'error');
  assert.match(over.message, /2001/);
  assert.match(over.message, /exceeds limit 2000/);
  console.log(`2001 节点 -> ${over.type}: ${over.message}`);

  const bulk1999 = loadPlugin(new Map(flatten(buildBulk(1999)).map((node) => [node.id, node])));
  const ok1999 = await bulk1999.send({ type: 'inspect', requestId: 'r-1999', nodeId: '9:1', mode: 'overview' });
  assert.equal(ok1999.type, 'inspect-result');
  assert.equal(ok1999.count, 1999);
  console.log(`1999 节点 -> ${ok1999.type}: count=${ok1999.count}`);

  const bulk2000 = loadPlugin(new Map(flatten(buildBulk(2000)).map((node) => [node.id, node])));
  const ok2000 = await bulk2000.send({ type: 'inspect', requestId: 'r-2000', nodeId: '9:1', mode: 'overview' });
  assert.equal(ok2000.type, 'inspect-result');
  assert.equal(ok2000.count, 2000);
  console.log(`2000 节点 -> ${ok2000.type}: count=${ok2000.count}`);

  section('10. 插件保留命令与错误分支');
  const pong = await plugin.send({ type: 'ping', requestId: 'r-ping' });
  assert.equal(pong.type, 'pong');
  const hs = await plugin.send({ type: 'handshake', requestId: 'r-hs' });
  assert.equal(hs.type, 'handshake-ack');
  assert.equal(hs.fileKey, 'stub-file');
  const brief = await plugin.send({ type: 'get-node', requestId: 'r-brief', nodeId: '1:1' });
  assert.equal(brief.type, 'node');
  assert.deepEqual(Object.keys(brief.node).sort(), ['id', 'name', 'type']);
  assert.equal(brief.node.id, '1:1');
  assert.equal(brief.node.name, 'Card');
  assert.equal(brief.node.type, 'FRAME');
  const missing = await plugin.send({ type: 'inspect', requestId: 'r-miss', nodeId: '404:0', mode: 'overview' });
  assert.equal(missing.type, 'error');
  assert.match(missing.message, /node not found/);
  const noId = await plugin.send({ type: 'inspect', requestId: 'r-noid', mode: 'overview' });
  assert.equal(noId.type, 'error');
  assert.match(noId.message, /nodeId required/);
  const unknown = await plugin.send({ type: 'nope', requestId: 'r-unknown' });
  assert.equal(unknown.type, 'error');
  console.log('assert: ping/handshake/get-node 保留，缺参、未知节点、未知命令 -> error ok');

  section('11. 异步节点 API 使用');
  const source = readFileSync(resolve(ROOT, 'plugin', 'main.js'), 'utf8');
  assert.match(source, /figma\.getNodeByIdAsync/);
  assert.ok(!/figma\.getNodeById\(/.test(source), '不得使用同步 getNodeById');
  assert.ok(!/figma\.root\.find/.test(source), '不得整文档同步遍历');
  console.log('assert: 使用 getNodeByIdAsync，未使用 getNodeById / root.findAll -> ok');

  console.log('\nALL CHECKS PASSED');
}

main().catch((error) => {
  console.error(`FAILED: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
