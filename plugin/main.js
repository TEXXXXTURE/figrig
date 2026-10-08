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
