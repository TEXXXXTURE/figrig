#!/usr/bin/env node
// cli：命令行入口。命令 connect（作为 channel 成员挂起）、bind（解析 Figma 链接并写入绑定）、
// read（按意图路由格式并读取节点）、expand（读取指定节点完整属性）、write（写入并断言）、
// review（导出 PNG）、recover（故障恢复）、component-add / component-list / component-use（组件注册表）、
// prototype（原型关系写入并读回断言）。
// 经 relay 的请求携带 UUID v4 格式 requestId，并记入任务记录以支持幂等与故障恢复。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { WebSocket } from 'ws';

import { INTENTS, selectFormat } from './formats/index.mjs';
import { convert as convertJsx } from './formats/jsx.mjs';
import { convert as convertJson } from './formats/json.mjs';
import { convert as convertSvg } from './formats/svg.mjs';
import { convert as convertPng } from './formats/png.mjs';
import { evaluateAssertion } from './assert.mjs';
import { WRITE_OPS, CREATE_SET } from './ops.mjs';
import { createTask, planOperation, setTaskStatus, uuidv4 } from './task-store.mjs';
import { resolveUnresolved } from './recover.mjs';
import { addComponent, buildTemplate, getComponent, readComponents, registryPath, replayTemplate } from './registry.mjs';
import { parseLinks, verifyReadback } from './prototype.mjs';

const RELAY_HOST = '127.0.0.1';
const RELAY_PORT = Number(process.env.FIGRIG_RELAY_PORT) || 3055;
const DEFAULT_CHANNEL = 'default';
const BINDING_DIR = resolve(process.cwd(), '.figrig');
const BINDING_FILE = join(BINDING_DIR, 'binding.json');
const IMAGE_DIR = resolve(process.cwd(), '.figrig-run', 'images');
const PATH_SEGMENTS = new Set(['file', 'design', 'proto', 'board', 'deck']);
const READ_TIMEOUT_MS = Number(process.env.FIGRIG_TIMEOUT_MS) || 15000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

// requestId：命令行提供时校验 UUID v4 格式，未提供时生成。
function requestIdFrom(options) {
  const raw = options.requestId;
  if (raw === undefined) return uuidv4();
  if (typeof raw !== 'string' || !UUID_V4.test(raw)) {
    fail(`invalid requestId (uuid v4 required): ${String(raw)}`);
  }
  return raw;
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

function openSocket(channel) {
  return new WebSocket(`ws://${RELAY_HOST}:${RELAY_PORT}?channel=${encodeURIComponent(channel)}`);
}

function transportError(message) {
  const error = new Error(message);
  error.transport = true;
  return error;
}

// 向插件发送 payload，等待同 requestId 的指定类型回包或 error。
// 超时、连接关闭、socket 错误标记 transport；插件侧 error 标记 plugin。
function requestRelay(options, payload, acceptType, label) {
  const channel = channelName(options.channel);
  const id = typeof options.id === 'string' && options.id.length > 0 ? options.id : 'cli';
  const socket = openSocket(channel);
  const recoverHint = `; run: node cli.mjs recover --requestId ${payload.requestId}`;

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
      finish(transportError(`timeout waiting for ${label} result (channel=${channel})${recoverHint}`));
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
        const error = new Error(parsed.message || `${label} failed`);
        error.plugin = true;
        finish(error);
        return;
      }
      if (parsed.type === acceptType) finish(null, parsed);
    });

    socket.on('error', (error) => {
      finish(transportError(`socket error: ${error.message}${recoverHint}`));
    });

    socket.on('close', () => {
      finish(transportError(`connection closed before ${label} result${recoverHint}`));
    });
  });
}

// 向插件发 inspect，等待 inspect-result。
function requestInspect(options, nodeId, mode, requestId) {
  return requestRelay(options, { type: 'inspect', requestId, nodeId, mode }, 'inspect-result', 'inspect');
}

// 向插件发 write，等待 write-result。
function requestWrite(options, payload) {
  return requestRelay(options, payload, 'write-result', 'write');
}

// 向插件发 preview，等待 preview-result。
function requestPreview(options, nodeId, requestId) {
  return requestRelay(options, { type: 'preview', requestId, nodeId }, 'preview-result', 'preview');
}

// 选项可能为单值或数组，统一为字符串数组。
function normalizeList(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [String(value)];
}

// 幂等包裹：判定重投、记录任务状态。execute 返回命令输出对象；transport 错误标记 unresolved。
async function withIdempotency(descriptor, { mutation }, execute) {
  const plan = planOperation(descriptor, { mutation });
  if (plan.action === 'conflict') {
    fail(`requestId ${descriptor.requestId} conflict: ${plan.reasons.join('; ')}`);
  }
  if (plan.action === 'blocked') {
    const hint = plan.task && plan.task.status === 'unresolved'
      ? `; run: node cli.mjs recover --requestId ${plan.task.requestId}`
      : '';
    fail(`operation blocked: ${plan.reason}${hint}`);
  }
  if (plan.action === 'reused') {
    return { output: plan.task.output, reused: true };
  }
  createTask(descriptor);
  setTaskStatus(descriptor.requestId, 'running');
  try {
    const output = await execute();
    setTaskStatus(descriptor.requestId, 'done', { output, reason: 'done' });
    return { output, reused: false };
  } catch (error) {
    const status = error && error.transport ? 'unresolved' : 'failed';
    setTaskStatus(descriptor.requestId, status, { reason: error && error.message ? error.message : String(error) });
    throw error;
  }
}

function reportReused(requestId, reused) {
  if (reused) process.stderr.write(`reused: ${requestId}\n`);
}

function commandConnect(options) {
  const channel = channelName(options.channel);
  const fileKey = options.fileKey || null;
  assertFileKey(fileKey);

  const binding = readBinding();
  const id = options.id || 'cli';
  const socket = openSocket(channel);

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
    fail(`usage: node cli.mjs read --intent <${INTENTS.join('|')}> [--nodeId <id>] [--requestId <uuid>]`);
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
  const requestId = requestIdFrom(options);
  const descriptor = { requestId, operation: 'read', nodeId, params: { intent, mode }, expect: [] };
  const { output, reused } = await withIdempotency(descriptor, { mutation: false }, async () => {
    const result = await requestInspect(options, nodeId, mode, requestId);
    const converted = converter(result.node);
    return { status: 'read', intent, format, text: typeof converted === 'string' ? converted : JSON.stringify(converted, null, 2) };
  });
  console.log(output.text);
  reportReused(requestId, reused);
}

// 读取指定子树完整属性。输出走 JSON 白名单转换器。
async function commandExpand(options) {
  const nodeId = resolveNodeId(options.nodeId) || bindingNodeId();
  if (!nodeId) fail('nodeId required: pass --nodeId or run bind first');
  const requestId = requestIdFrom(options);
  const descriptor = { requestId, operation: 'expand', nodeId, params: { mode: 'full' }, expect: [] };
  const { output, reused } = await withIdempotency(descriptor, { mutation: false }, async () => {
    const result = await requestInspect(options, nodeId, 'full', requestId);
    return { status: 'expanded', nodeId, text: convertJson(result.node) };
  });
  console.log(output.text);
  reportReused(requestId, reused);
}

// 写入节点：经 relay 发 write，对回包节点或删除回执执行断言核验。
async function commandWrite(options) {
  const op = options.op;
  if (typeof op !== 'string' || op.length === 0) {
    fail(`usage: node cli.mjs write --op <${WRITE_OPS.join('|')}> [--parentId <id>] [--nodeId <id>] [--params <json>] [--expect <assertion>]... [--requestId <uuid>]`);
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
  const parentId = resolveNodeId(options.parentId);
  const nodeId = resolveNodeId(options.nodeId);
  const requestId = requestIdFrom(options);
  const targetNodeId = CREATE_SET.has(op) ? parentId : nodeId;
  const descriptor = { requestId, operation: op, nodeId: targetNodeId, params, expect: expects };
  const { output, reused } = await withIdempotency(descriptor, { mutation: true }, async () => {
    const payload = { type: 'write', requestId, op, parentId, nodeId, params };
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
    const resultNodeId = result.deleted !== undefined ? result.nodeId : result.node.id;
    if (failures.length > 0) {
      const error = new Error('assertion failed');
      error.output = { status: 'failed', op, nodeId: resultNodeId, assertions: passed, failures };
      throw error;
    }
    return { status: 'applied', op, nodeId: resultNodeId, assertions: passed };
  });
  console.log(JSON.stringify({ ...output, reused }));
}

// 图片导出：经 preview 取 PNG 字节写入 .figrig-run/images，输出路径引用。
async function commandReview(options) {
  const nodeId = resolveNodeId(options.nodeId) || bindingNodeId();
  if (!nodeId) fail('nodeId required: pass --nodeId or run bind first');
  const requestId = requestIdFrom(options);
  const descriptor = { requestId, operation: 'review', nodeId, params: { mode: 'png' }, expect: [] };
  const { output, reused } = await withIdempotency(descriptor, { mutation: false }, async () => {
    const result = await requestPreview(options, nodeId, requestId);
    const bytes = Buffer.from(result.bytes);
    mkdirSync(IMAGE_DIR, { recursive: true });
    const normalized = nodeId.replace(/:/g, '_');
    const path = join(IMAGE_DIR, `${normalized}-${Date.now()}.png`);
    writeFileSync(path, bytes);
    return { status: 'exported', nodeId, path };
  });
  console.log(JSON.stringify({ ...output, reused }));
}

// 故障恢复：对 unresolved 任务发起独立 inspect，按核验结果判定状态。不重放原操作。
async function commandRecover(options) {
  const requestId = typeof options.requestId === 'string' && options.requestId.length > 0 ? options.requestId : null;
  const nodeId = resolveNodeId(options.nodeId);
  if (!requestId && !nodeId) fail('usage: node cli.mjs recover (--requestId <uuid> | --nodeId <id>)');
  const inspect = async (targetId) => {
    try {
      const result = await requestInspect(options, targetId, 'full', uuidv4());
      return { found: true, node: result.node };
    } catch (error) {
      if (!error.transport && /node not found/.test(error.message)) return { found: false };
      throw error;
    }
  };
  const report = await resolveUnresolved({ requestId, nodeId }, { inspect });
  console.log(JSON.stringify(report, null, 2));
  if (report.pending > 0) process.exitCode = 1;
}

// 组件登记：读取指定节点 full 序列化，生成操作模板；--confirm 后写入注册表。
async function commandComponentAdd(options) {
  const name = typeof options.name === 'string' && options.name.length > 0 ? options.name : null;
  if (!name) fail('usage: node cli.mjs component-add --name <name> [--nodeId <id>] [--source local|imported] [--confirm]');
  const nodeId = resolveNodeId(options.nodeId) || bindingNodeId();
  if (!nodeId) fail('nodeId required: pass --nodeId or run bind first');
  const source = options.source === 'imported' ? 'imported' : 'local';
  const result = await requestInspect(options, nodeId, 'full', uuidv4());
  const template = buildTemplate(result.node);
  if (options.confirm !== 'true') {
    console.log(JSON.stringify({ status: 'confirm-required', name, nodeId, source, template }, null, 2));
    return;
  }
  const record = addComponent({ name, nodeId, source, template });
  console.log(JSON.stringify({
    status: 'registered',
    name: record.name,
    nodeId: record.nodeId,
    source: record.source,
    steps: record.template.length,
    path: registryPath(),
  }, null, 2));
}

// 组件列表：输出注册表条目概要。
function commandComponentList() {
  const components = readComponents();
  const summary = components.map((entry) => ({
    name: entry.name,
    nodeId: entry.nodeId,
    source: entry.source,
    steps: Array.isArray(entry.template) ? entry.template.length : 0,
  }));
  console.log(JSON.stringify({ count: summary.length, components: summary, path: registryPath() }, null, 2));
}

// 原型关系写入：--file 或 --json 给定 links；经 relay 发 prototype，读回 reactions 断言核验。
// 差异式语义：links 仅列需设置的关系；同一 from 节点整体替换 reactions，不做增量合并。
async function commandPrototype(options) {
  let text = null;
  if (typeof options.file === 'string' && options.file.length > 0) {
    try {
      text = readFileSync(resolve(options.file), 'utf8');
    } catch {
      fail(`cannot read file: ${options.file}`);
    }
  } else if (typeof options.json === 'string' && options.json.length > 0) {
    text = options.json;
  } else {
    fail('usage: node cli.mjs prototype (--file <json> | --json <json>) [--requestId <uuid>] [--channel <name>]');
  }
  let links;
  try {
    links = parseLinks(text);
  } catch (error) {
    fail(error.message);
  }
  const requestId = requestIdFrom(options);
  const descriptor = { requestId, operation: 'prototype', nodeId: null, params: { links }, expect: [] };
  const { output, reused } = await withIdempotency(descriptor, { mutation: true }, async () => {
    const result = await requestRelay(options, { type: 'prototype', requestId, links }, 'prototype-result', 'prototype');
    const failures = verifyReadback(links, result.readback);
    if (failures.length > 0) {
      const error = new Error('prototype assertion failed');
      error.output = { status: 'failed', links: links.length, failures };
      throw error;
    }
    return { status: 'applied', links: links.length, nodes: result.nodes ?? 0 };
  });
  console.log(JSON.stringify({ ...output, reused }));
}

// 组件复用：按模板在新父节点下逐条执行并逐条断言。
async function commandComponentUse(options) {
  const name = typeof options.name === 'string' && options.name.length > 0 ? options.name : null;
  if (!name) fail('usage: node cli.mjs component-use --name <name> --parentId <id> [--requestId <uuid>]');
  const parentId = resolveNodeId(options.parentId) || bindingNodeId();
  if (!parentId) fail('parentId required: pass --parentId or run bind first');
  const component = getComponent(name);
  if (!component) fail(`component not found: ${name}`);
  const template = Array.isArray(component.template) ? component.template : [];
  const requestId = requestIdFrom(options);
  const descriptor = { requestId, operation: 'component-use', nodeId: parentId, params: { name, steps: template.length }, expect: [] };
  const { output, reused } = await withIdempotency(descriptor, { mutation: true }, async () => {
    const steps = await replayTemplate(template, parentId, ({ op, parentId: stepParent, nodeId, params }) => requestWrite(options, {
      type: 'write',
      requestId: uuidv4(),
      op,
      parentId: stepParent,
      nodeId,
      params,
    }));
    return { status: 'applied', component: name, parentId, steps };
  });
  console.log(JSON.stringify({ ...output, reused }));
}

function usage() {
  console.log('usage: node cli.mjs <command> [args]');
  console.log('  connect [--channel <name>] [--id <name>] [--fileKey <key>]');
  console.log('  bind <figma-url>');
  console.log(`  read --intent <${INTENTS.join('|')}> [--nodeId <id>] [--requestId <uuid>] [--channel <name>]`);
  console.log('  expand [--nodeId <id>] [--requestId <uuid>] [--channel <name>]');
  console.log(`  write --op <${WRITE_OPS.join('|')}> [--parentId <id>] [--nodeId <id>] [--params <json>] [--expect <assertion>]... [--requestId <uuid>]`);
  console.log('  review --nodeId <id> [--requestId <uuid>] [--channel <name>]');
  console.log('  recover (--requestId <uuid> | --nodeId <id>) [--channel <name>]');
  console.log('  component-add --name <name> [--nodeId <id>] [--source local|imported] [--confirm]');
  console.log('  component-list');
  console.log('  component-use --name <name> --parentId <id> [--requestId <uuid>]');
  console.log('  prototype (--file <json> | --json <json>) [--requestId <uuid>] [--channel <name>]');
}

function handleCommandError(error) {
  if (error && error.output) {
    console.log(JSON.stringify(error.output));
    process.exit(1);
  }
  fail(error && error.message ? error.message : String(error));
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
    commandRead(options).catch(handleCommandError);
    return;
  }
  if (command === 'expand') {
    commandExpand(options).catch(handleCommandError);
    return;
  }
  if (command === 'write') {
    commandWrite(options).catch(handleCommandError);
    return;
  }
  if (command === 'review') {
    commandReview(options).catch(handleCommandError);
    return;
  }
  if (command === 'recover') {
    commandRecover(options).catch(handleCommandError);
    return;
  }
  if (command === 'component-add') {
    commandComponentAdd(options).catch(handleCommandError);
    return;
  }
  if (command === 'component-list') {
    commandComponentList();
    return;
  }
  if (command === 'component-use') {
    commandComponentUse(options).catch(handleCommandError);
    return;
  }
  if (command === 'prototype') {
    commandPrototype(options).catch(handleCommandError);
    return;
  }
  fail(`unknown command: ${command}`);
}

main();
