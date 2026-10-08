// main：插件主线程。接收 UI 转发的命令，读取画布节点与文件标识后回包。

figma.showUI(__html__, { width: 360, height: 340, title: 'FigRig' });

const NODE_LIMIT = 2000;

function post(message) {
  figma.ui.postMessage(message);
}

function nodeBrief(node) {
  return { id: node.id, name: node.name, type: node.type };
}

async function handleHandshake(message) {
  post({
    type: 'handshake-ack',
    requestId: message.requestId ?? null,
    fileKey: figma.fileKey ?? null,
    fileName: figma.root.name,
    editorType: figma.editorType,
    apiVersion: figma.apiVersion,
  });
}

async function handleGetNode(message) {
  const nodeId = message.nodeId;
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    post({ type: 'error', requestId: message.requestId ?? null, message: 'nodeId required' });
    return;
  }
  const node = await figma.getNodeByIdAsync(nodeId);
  if (node === null) {
    post({ type: 'error', requestId: message.requestId ?? null, message: `node not found: ${nodeId}` });
    return;
  }
  post({
    type: 'node',
    requestId: message.requestId ?? null,
    fileKey: figma.fileKey ?? null,
    node: nodeBrief(node),
  });
}

function byteHex(value) {
  const n = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 255);
  return n.toString(16).padStart(2, '0').toUpperCase();
}

function rgbaText(color, alpha) {
  const r = Math.round(Math.max(0, Math.min(1, Number(color.r) || 0)) * 255);
  const g = Math.round(Math.max(0, Math.min(1, Number(color.g) || 0)) * 255);
  const b = Math.round(Math.max(0, Math.min(1, Number(color.b) || 0)) * 255);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 100) / 100})`;
}

// 色值以原始形式输出：SOLID 给出 hex 与 rgba；其余类型仅给类型。
function serializeFills(fills) {
  if (!Array.isArray(fills)) return undefined;
  const result = [];
  for (const paint of fills) {
    if (paint === null || typeof paint !== 'object') continue;
    const entry = { type: paint.type };
    if (typeof paint.visible === 'boolean') entry.visible = paint.visible;
    if (typeof paint.opacity === 'number') entry.opacity = paint.opacity;
    if (paint.type === 'SOLID' && paint.color && typeof paint.color === 'object') {
      const alpha = typeof paint.color.a === 'number'
        ? paint.color.a
        : (typeof paint.opacity === 'number' ? paint.opacity : 1);
      entry.hex = `#${byteHex(paint.color.r)}${byteHex(paint.color.g)}${byteHex(paint.color.b)}`;
      entry.rgba = rgbaText(paint.color, alpha);
    }
    result.push(entry);
  }
  return result;
}

// 结构概览：每节点仅 id/name/type/children。
async function buildOverview(node, counter) {
  counter.count += 1;
  if (counter.count > NODE_LIMIT) {
    throw new Error(`inspect node count ${counter.count} exceeds limit ${NODE_LIMIT}`);
  }
  const out = { id: node.id, name: node.name, type: node.type };
  out.children = [];
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      out.children.push(await buildOverview(child, counter));
    }
  }
  return out;
}

// 完整属性：结构概览字段之外追加几何、布局、填充、文本属性。
async function buildFull(node, counter) {
  counter.count += 1;
  if (counter.count > NODE_LIMIT) {
    throw new Error(`inspect node count ${counter.count} exceeds limit ${NODE_LIMIT}`);
  }
  const out = { id: node.id, name: node.name, type: node.type };
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof node[key] === 'number') out[key] = node[key];
  }
  if (typeof node.layoutMode === 'string') out.layoutMode = node.layoutMode;
  if (typeof node.itemSpacing === 'number') out.itemSpacing = node.itemSpacing;
  for (const key of ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom']) {
    if (typeof node[key] === 'number') out[key] = node[key];
  }
  const fills = serializeFills(node.fills);
  if (fills !== undefined) out.fills = fills;
  if (typeof node.characters === 'string') out.characters = node.characters;
  if (typeof node.fontSize === 'number') out.fontSize = node.fontSize;
  out.children = [];
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      out.children.push(await buildFull(child, counter));
    }
  }
  return out;
}

async function handleInspect(message) {
  const nodeId = message.nodeId;
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    post({ type: 'error', requestId: message.requestId ?? null, message: 'nodeId required' });
    return;
  }
  const mode = message.mode === 'full' ? 'full' : 'overview';
  const root = await figma.getNodeByIdAsync(nodeId);
  if (root === null) {
    post({ type: 'error', requestId: message.requestId ?? null, message: `node not found: ${nodeId}` });
    return;
  }
  const counter = { count: 0 };
  try {
    const node = mode === 'full' ? await buildFull(root, counter) : await buildOverview(root, counter);
    post({
      type: 'inspect-result',
      requestId: message.requestId ?? null,
      fileKey: figma.fileKey ?? null,
      mode,
      count: counter.count,
      node,
    });
  } catch (error) {
    post({
      type: 'error',
      requestId: message.requestId ?? null,
      message: String(error && error.message ? error.message : error),
    });
  }
}

const WRITE_OPS = Object.freeze([
  'create-frame',
  'create-rectangle',
  'create-text',
  'move',
  'resize',
  'delete',
  'set-fill',
  'set-layout',
  'set-padding',
  'set-item-spacing',
]);

const CREATE_OPS = new Set(['create-frame', 'create-rectangle', 'create-text']);
const PADDING_KEYS = ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'];

function postError(message, text) {
  post({ type: 'error', requestId: message.requestId ?? null, message: text });
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// 十六进制色值转 0-1 分量。支持 #RGB / #RRGGBB / #RRGGBBAA；无法解析返回 null。
function parseHexColor(hex) {
  if (typeof hex !== 'string') return null;
  const text = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(text)) return null;
  if (text.length === 3) {
    return {
      r: parseInt(text[0] + text[0], 16) / 255,
      g: parseInt(text[1] + text[1], 16) / 255,
      b: parseInt(text[2] + text[2], 16) / 255,
      a: 1,
    };
  }
  if (text.length === 6 || text.length === 8) {
    return {
      r: parseInt(text.slice(0, 2), 16) / 255,
      g: parseInt(text.slice(2, 4), 16) / 255,
      b: parseInt(text.slice(4, 6), 16) / 255,
      a: text.length === 8 ? parseInt(text.slice(6, 8), 16) / 255 : 1,
    };
  }
  return null;
}

// 由 params 解析填充色：优先 hex，其次 r/g/b（可选 a）。
function colorFromParams(params) {
  if (params.hex !== undefined) {
    const color = parseHexColor(params.hex);
    if (color === null) return { error: `invalid hex: ${String(params.hex)}` };
    return { color };
  }
  if (typeof params.r === 'number' && typeof params.g === 'number' && typeof params.b === 'number') {
    const a = typeof params.a === 'number' ? params.a : 1;
    return { color: { r: clamp01(params.r), g: clamp01(params.g), b: clamp01(params.b), a: clamp01(a) } };
  }
  return { error: 'set-fill requires hex or r/g/b' };
}

// 几何写入：width/height 经 resize；x/y 直接赋值。
function applyGeometry(node, params) {
  const hasWidth = typeof params.width === 'number';
  const hasHeight = typeof params.height === 'number';
  if (hasWidth || hasHeight) {
    const width = hasWidth ? params.width : node.width;
    const height = hasHeight ? params.height : node.height;
    if (typeof node.resize === 'function') node.resize(width, height);
    else {
      node.width = width;
      node.height = height;
    }
  }
  if (typeof params.x === 'number') node.x = params.x;
  if (typeof params.y === 'number') node.y = params.y;
}

// 修改类操作执行后序列化目标节点，随回包返回。
async function respondNode(message, op, node) {
  const counter = { count: 0 };
  const serialized = await buildFull(node, counter);
  post({
    type: 'write-result',
    requestId: message.requestId ?? null,
    fileKey: figma.fileKey ?? null,
    op,
    node: serialized,
  });
}

async function handleCreate(message, op, params) {
  const parentId = message.parentId;
  if (typeof parentId !== 'string' || parentId.length === 0) {
    postError(message, 'parentId required');
    return;
  }
  const parent = await figma.getNodeByIdAsync(parentId);
  if (parent === null) {
    postError(message, `parent not found: ${parentId}`);
    return;
  }
  let node;
  if (op === 'create-frame') {
    node = figma.createFrame();
  } else if (op === 'create-rectangle') {
    node = figma.createRectangle();
  } else {
    node = figma.createText();
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  }
  if (typeof params.name === 'string') node.name = params.name;
  if (typeof params.characters === 'string') node.characters = params.characters;
  parent.appendChild(node);
  applyGeometry(node, params);
  await respondNode(message, op, node);
}

async function handleDelete(message) {
  const nodeId = message.nodeId;
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    postError(message, 'nodeId required');
    return;
  }
  const node = await figma.getNodeByIdAsync(nodeId);
  if (node === null) {
    postError(message, `node not found: ${nodeId}`);
    return;
  }
  node.remove();
  post({
    type: 'write-result',
    requestId: message.requestId ?? null,
    fileKey: figma.fileKey ?? null,
    op: 'delete',
    deleted: true,
    nodeId,
  });
}

async function handleModify(message, op, params) {
  const nodeId = message.nodeId;
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    postError(message, 'nodeId required');
    return;
  }
  const node = await figma.getNodeByIdAsync(nodeId);
  if (node === null) {
    postError(message, `node not found: ${nodeId}`);
    return;
  }
  switch (op) {
    case 'move': {
      if (typeof params.x !== 'number' && typeof params.y !== 'number') {
        postError(message, 'move requires x or y');
        return;
      }
      applyGeometry(node, params);
      break;
    }
    case 'resize': {
      if (typeof params.width !== 'number' && typeof params.height !== 'number') {
        postError(message, 'resize requires width or height');
        return;
      }
      applyGeometry(node, params);
      break;
    }
    case 'set-fill': {
      const result = colorFromParams(params);
      if (result.error) {
        postError(message, result.error);
        return;
      }
      node.fills = [{ type: 'SOLID', color: result.color }];
      break;
    }
    case 'set-layout': {
      const layoutMode = params.layoutMode;
      if (layoutMode !== 'HORIZONTAL' && layoutMode !== 'VERTICAL') {
        postError(message, 'set-layout requires layoutMode HORIZONTAL or VERTICAL');
        return;
      }
      node.layoutMode = layoutMode;
      node.primaryAxisSizingMode = 'AUTO';
      node.counterAxisSizingMode = 'AUTO';
      break;
    }
    case 'set-padding': {
      let applied = false;
      if (typeof params.padding === 'number') {
        for (const key of PADDING_KEYS) node[key] = params.padding;
        applied = true;
      }
      for (const key of PADDING_KEYS) {
        if (typeof params[key] === 'number') {
          node[key] = params[key];
          applied = true;
        }
      }
      if (!applied) {
        postError(message, 'set-padding requires padding or padding* numeric');
        return;
      }
      break;
    }
    case 'set-item-spacing': {
      if (typeof params.itemSpacing !== 'number') {
        postError(message, 'set-item-spacing requires itemSpacing');
        return;
      }
      node.itemSpacing = params.itemSpacing;
      break;
    }
    default: {
      postError(message, `invalid op: ${String(op)}`);
      return;
    }
  }
  await respondNode(message, op, node);
}

async function handleWrite(message) {
  const op = message.op;
  if (typeof op !== 'string' || !WRITE_OPS.includes(op)) {
    postError(message, `invalid op: ${String(op)}; allowed: ${WRITE_OPS.join(', ')}`);
    return;
  }
  const params = message.params !== null && typeof message.params === 'object' ? message.params : {};
  if (CREATE_OPS.has(op)) {
    await handleCreate(message, op, params);
    return;
  }
  if (op === 'delete') {
    await handleDelete(message);
    return;
  }
  await handleModify(message, op, params);
}

async function handlePreview(message) {
  const nodeId = message.nodeId;
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    postError(message, 'nodeId required');
    return;
  }
  const node = await figma.getNodeByIdAsync(nodeId);
  if (node === null) {
    postError(message, `node not found: ${nodeId}`);
    return;
  }
  const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
  post({
    type: 'preview-result',
    requestId: message.requestId ?? null,
    bytes: Array.from(bytes),
    nodeId,
  });
}

async function handle(message) {
  switch (message.type) {
    case 'handshake':
      await handleHandshake(message);
      return;
    case 'get-node':
      await handleGetNode(message);
      return;
    case 'inspect':
      await handleInspect(message);
      return;
    case 'write':
      await handleWrite(message);
      return;
    case 'preview':
      await handlePreview(message);
      return;
    case 'ping':
      post({ type: 'pong', requestId: message.requestId ?? null, fileKey: figma.fileKey ?? null });
      return;
    default:
      post({ type: 'error', requestId: message.requestId ?? null, message: `unknown command: ${message.type}` });
  }
}

figma.ui.onmessage = (message) => {
  if (message === null || typeof message !== 'object') return;
  handle(message).catch((error) => {
    post({ type: 'error', requestId: message.requestId ?? null, message: String(error && error.message ? error.message : error) });
  });
};
