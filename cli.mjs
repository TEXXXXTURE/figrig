#!/usr/bin/env node
// cli：命令行入口。命令 connect（作为 channel 成员挂起）、bind（解析 Figma 链接并写入绑定）、
// read（按意图路由格式并读取节点）、expand（读取指定节点完整属性）。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { WebSocket } from 'ws';

import { INTENTS, selectFormat } from './formats/index.mjs';
import { convert as convertJsx } from './formats/jsx.mjs';
import { convert as convertJson } from './formats/json.mjs';
import { convert as convertSvg } from './formats/svg.mjs';
import { convert as convertPng } from './formats/png.mjs';
import { evaluateAssertion } from './assert.mjs';

const RELAY_HOST = '127.0.0.1';
const RELAY_PORT = 3055;
const DEFAULT_CHANNEL = 'default';
const BINDING_DIR = resolve(process.cwd(), '.figrig');
const BINDING_FILE = join(BINDING_DIR, 'binding.json');
const IMAGE_DIR = resolve(process.cwd(), '.figrig-run', 'images');
const PATH_SEGMENTS = new Set(['file', 'design', 'proto', 'board', 'deck']);
const READ_TIMEOUT_MS = 15000;

// 写入操作枚举，与 plugin/main.js 的 WRITE_OPS 一致。
const WRITE_OPS = [
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
];

// 格式名 -> 转换器。
const CONVERTERS = {
  jsx: convertJsx,
  json: convertJson,
  svg: convertSvg,
  png: convertPng,
};

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function readBinding() {
  if (!existsSync(BINDING_FILE)) return null;
  try {
    return JSON.parse(readFileSync(BINDING_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeBinding(binding) {
  mkdirSync(BINDING_DIR, { recursive: true });
  writeFileSync(BINDING_FILE, `${JSON.stringify(binding, null, 2)}\n`, 'utf8');
}

// binding 存在且 fileKey 不同则报错。
function assertFileKey(fileKey) {
  if (!fileKey) return;
  const binding = readBinding();
  if (!binding) return;
  if (binding.fileKey !== fileKey) {
    fail(`fileKey mismatch: binding=${binding.fileKey} given=${fileKey}`);
  }
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      let key;
      let value;
      if (eq >= 0) {
        key = body.slice(0, eq);
        value = body.slice(eq + 1);
      } else {
        key = body;
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i += 1;
        } else {
          value = 'true';
        }
      }
      // 同名重复传入累积为数组（如多个 --expect）。
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        const existing = options[key];
        if (Array.isArray(existing)) existing.push(value);
        else options[key] = [existing, value];
      } else {
        options[key] = value;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, options };
}

function normalizeNodeId(raw) {
  if (!raw) return null;
  const decoded = decodeURIComponent(raw).trim();
  const value = decoded.replace(/-/g, ':');
  if (!/^\d+:\d+$/.test(value)) return null;
  return value;
}

// 命令行 nodeId：接受链接式写法（1-23）与内部写法（1:23），其余原样透传。
function resolveNodeId(raw) {
  if (raw === undefined || raw === null) return null;
  const value = decodeURIComponent(String(raw)).trim();
  if (value.length === 0) return null;
  return value.replace(/-/g, ':');
}

function bindingNodeId() {
  const binding = readBinding();
  return binding && binding.nodeId ? binding.nodeId : null;
}

function parseFigmaUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`invalid url: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'figma.com' && !host.endsWith('.figma.com')) {
    fail(`not a figma url: ${parsed.hostname}`);
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2 || !PATH_SEGMENTS.has(segments[0])) {
    fail(`no file key in path: ${parsed.pathname}`);
  }
  const fileKey = segments[1];
  const rawNode = parsed.searchParams.get('node-id');
  const nodeId = normalizeNodeId(rawNode);
  if (rawNode && !nodeId) fail(`invalid node-id: ${rawNode}`);
  return { fileKey, nodeId, url: parsed.toString() };
}

function channelName(raw) {
  if (typeof raw !== 'string') return DEFAULT_CHANNEL;
  return raw.trim() || DEFAULT_CHANNEL;
}

function openSocket(channel, id) {
  const socket = new WebSocket(`ws://${RELAY_HOST}:${RELAY_PORT}?channel=${encodeURIComponent(channel)}`);
  return socket;
}

function requestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// 向插件发送 payload，等待同 requestId 的指定类型回包或 error。
function requestRelay(options, payload, acceptType, label) {
  const channel = channelName(options.channel);
  const id = typeof options.id === 'string' && options.id.length > 0 ? options.id : 'cli';
  const socket = openSocket(channel, id);

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // 关闭失败不影响已完成的请求。
      }
      if (error) rejectPromise(error);
      else resolvePromise(value);
    }

    const timer = setTimeout(() => {
      finish(new Error(`timeout waiting for ${label} result (channel=${channel})`));
    }, READ_TIMEOUT_MS);

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'figrig-id', id }));
      socket.send(JSON.stringify(payload));
    });

    socket.on('message', (data) => {
      let parsed = null;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!parsed || parsed.requestId !== payload.requestId) return;
      if (parsed.type === 'error') {
        finish(new Error(parsed.message || `${label} failed`));
        return;
      }
      if (parsed.type === acceptType) finish(null, parsed);
    });

    socket.on('error', (error) => {
      finish(new Error(`socket error: ${error.message}`));
    });

    socket.on('close', () => {
      finish(new Error(`connection closed before ${label} result`));
    });
  });
}

// 向插件发 inspect，等待 inspect-result。
function requestInspect(options, nodeId, mode) {
  return requestRelay(
    options,
    { type: 'inspect', requestId: requestId(), nodeId, mode },
    'inspect-result',
    'inspect',
  );
}

// 向插件发 write，等待 write-result。
function requestWrite(options, payload) {
  return requestRelay(options, payload, 'write-result', 'write');
}

// 向插件发 preview，等待 preview-result。
function requestPreview(options, nodeId) {
  return requestRelay(
    options,
    { type: 'preview', requestId: requestId(), nodeId },
    'preview-result',
    'preview',
  );
}

// 选项可能为单值或数组，统一为字符串数组。
function normalizeList(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [String(value)];
}

function commandConnect(options) {
  const channel = channelName(options.channel);
  const fileKey = options.fileKey || null;
  assertFileKey(fileKey);

  const binding = readBinding();
  const id = options.id || 'cli';
  const socket = openSocket(channel, id);

  socket.on('open', () => {
    socket.send(JSON.stringify({ type: 'figrig-id', id }));
    console.log(JSON.stringify({
      status: 'connected',
      channel,
      id,
      url: `ws://${RELAY_HOST}:${RELAY_PORT}`,
      binding: binding ? { fileKey: binding.fileKey, nodeId: binding.nodeId } : null,
    }));
  });

  socket.on('message', (data) => {
    const text = data.toString();
    console.log(JSON.stringify({ status: 'message', channel, raw: text }));
  });

  socket.on('close', () => {
    console.log(JSON.stringify({ status: 'closed', channel }));
    process.exit(0);
  });

  socket.on('error', (error) => {
    fail(`socket error: ${error.message}`);
  });

  process.on('SIGINT', () => {
    socket.close();
  });
}

function commandBind(positional) {
  const url = positional[0];
  if (!url) fail('usage: node cli.mjs bind <figma-url>');
  const parsed = parseFigmaUrl(url);
  const binding = {
    fileKey: parsed.fileKey,
    nodeId: parsed.nodeId,
    url: parsed.url,
    boundAt: new Date().toISOString(),
  };
  writeBinding(binding);
  console.log(JSON.stringify({ status: 'bound', path: BINDING_FILE, binding }));
}

// 校验 intent，路由格式，按格式选择读取深度：jsx 用 overview，其余用 full。
async function commandRead(options) {
  const intent = options.intent;
  if (typeof intent !== 'string' || intent.length === 0) {
    fail(`usage: node cli.mjs read --intent <${INTENTS.join('|')}> [--nodeId <id>]`);
  }
  if (!INTENTS.includes(intent)) {
    fail(`invalid intent: ${intent}; allowed: ${INTENTS.join(', ')}`);
  }
  const format = selectFormat(intent);
  const converter = CONVERTERS[format];
  if (typeof converter !== 'function') fail(`no converter for format: ${format}`);
  const nodeId = resolveNodeId(options.nodeId) || bindingNodeId();
  if (!nodeId) fail('nodeId required: pass --nodeId or run bind first');
  const mode = format === 'jsx' ? 'overview' : 'full';
  const result = await requestInspect(options, nodeId, mode);
  const output = converter(result.node);
  console.log(typeof output === 'string' ? output : JSON.stringify(output, null, 2));
}

// 读取指定子树完整属性。输出走 JSON 白名单转换器。
async function commandExpand(options) {
  const nodeId = resolveNodeId(options.nodeId) || bindingNodeId();
  if (!nodeId) fail('nodeId required: pass --nodeId or run bind first');
  const result = await requestInspect(options, nodeId, 'full');
  console.log(convertJson(result.node));
}

// 写入节点：经 relay 发 write，对回包节点或删除回执执行断言核验。
async function commandWrite(options) {
  const op = options.op;
  if (typeof op !== 'string' || op.length === 0) {
    fail(`usage: node cli.mjs write --op <${WRITE_OPS.join('|')}> [--parentId <id>] [--nodeId <id>] [--params <json>] [--expect <assertion>]...`);
  }
  if (!WRITE_OPS.includes(op)) {
    fail(`invalid op: ${op}; allowed: ${WRITE_OPS.join(', ')}`);
  }
  let params = {};
  if (typeof options.params === 'string') {
    try {
      params = JSON.parse(options.params);
    } catch {
      fail(`invalid params json: ${options.params}`);
    }
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      fail('params must be a json object');
    }
  }
  const expects = normalizeList(options.expect);
  const payload = {
    type: 'write',
    requestId: requestId(),
    op,
    parentId: resolveNodeId(options.parentId),
    nodeId: resolveNodeId(options.nodeId),
    params,
  };
  const result = await requestWrite(options, payload);
  // 删除回执以自身为断言目标，其余以回包节点为断言目标。
  const target = result.deleted !== undefined ? result : result.node;
  const failures = [];
  let passed = 0;
  for (const assertion of expects) {
    const outcome = evaluateAssertion(target, assertion);
    if (outcome.ok) passed += 1;
    else failures.push({ assertion: outcome.assertion, reason: outcome.reason });
  }
  if (failures.length > 0) {
    console.log(JSON.stringify({ status: 'failed', assertions: passed, failures }));
    process.exit(1);
  }
  console.log(JSON.stringify({ status: 'applied', assertions: passed }));
}

// 图片导出：经 preview 取 PNG 字节写入 .figrig-run/images，输出路径引用。
async function commandReview(options) {
  const nodeId = resolveNodeId(options.nodeId) || bindingNodeId();
  if (!nodeId) fail('nodeId required: pass --nodeId or run bind first');
  const result = await requestPreview(options, nodeId);
  const bytes = Buffer.from(result.bytes);
  mkdirSync(IMAGE_DIR, { recursive: true });
  const normalized = nodeId.replace(/:/g, '_');
  const path = join(IMAGE_DIR, `${normalized}-${Date.now()}.png`);
  writeFileSync(path, bytes);
  console.log(JSON.stringify({ status: 'exported', path }));
}

function usage() {
  console.log('usage: node cli.mjs <command> [args]');
  console.log('  connect [--channel <name>] [--id <name>] [--fileKey <key>]');
  console.log('  bind <figma-url>');
  console.log(`  read --intent <${INTENTS.join('|')}> [--nodeId <id>] [--channel <name>]`);
  console.log('  expand [--nodeId <id>] [--channel <name>]');
  console.log(`  write --op <${WRITE_OPS.join('|')}> [--parentId <id>] [--nodeId <id>] [--params <json>] [--expect <assertion>]...`);
  console.log('  review --nodeId <id> [--channel <name>]');
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const { positional, options } = parseArgs(argv.slice(1));
  if (!command || command === 'help' || command === '--help') {
    usage();
    process.exit(command ? 0 : 1);
  }
  if (command === 'connect') {
    commandConnect(options);
    return;
  }
  if (command === 'bind') {
    commandBind(positional);
    return;
  }
  if (command === 'read') {
    commandRead(options).catch((error) => fail(error.message));
    return;
  }
  if (command === 'expand') {
    commandExpand(options).catch((error) => fail(error.message));
    return;
  }
  if (command === 'write') {
    commandWrite(options).catch((error) => fail(error.message));
    return;
  }
  if (command === 'review') {
    commandReview(options).catch((error) => fail(error.message));
    return;
  }
  fail(`unknown command: ${command}`);
}

main();
