// main：插件主线程。接收 UI 转发的命令，读取画布节点与文件标识后回包。

figma.showUI(__html__, { width: 360, height: 340, title: 'FigRig' });

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

async function handle(message) {
  switch (message.type) {
    case 'handshake':
      await handleHandshake(message);
      return;
    case 'get-node':
      await handleGetNode(message);
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
