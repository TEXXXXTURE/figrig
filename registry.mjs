// registry：组件注册表模块。读写 .figrig/components.json，登记节点操作模板并支持逐条复放。
// 条目字段：name、nodeId、template、source。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evaluateAssertion } from './assert.mjs';
import { CREATE_SET, expectedAssertions } from './ops.mjs';

const REGISTRY_DIR = resolve(process.cwd(), '.figrig');
const REGISTRY_FILE = join(REGISTRY_DIR, 'components.json');
const PADDING_KEYS = ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'];

export function registryPath() {
  return REGISTRY_FILE;
}

export function readComponents() {
  if (!existsSync(REGISTRY_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeComponents(list) {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  writeFileSync(REGISTRY_FILE, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  return list;
}

export function getComponent(name) {
  return readComponents().find((entry) => entry.name === name) ?? null;
}

export function addComponent(entry) {
  const list = readComponents();
  if (list.some((item) => item.name === entry.name)) {
    throw new Error(`component already registered: ${entry.name}`);
  }
  const record = { ...entry, createdAt: new Date().toISOString() };
  list.push(record);
  writeComponents(list);
  return record;
}

// 由 full 序列化节点生成模板：先序展开，每节点一条 create，属性写入逐条追加。
// ref 为 -1 表示顶层父节点，否则为父节点 create 条目下标；属性条目 ref 指向所属 create 条目下标。
export function buildTemplate(node, parentRef = -1, out = []) {
  if (node === null || typeof node !== 'object') return out;
  const type = node.type;
  const op = type === 'TEXT' ? 'create-text' : type === 'RECTANGLE' ? 'create-rectangle' : 'create-frame';
  const params = {};
  if (typeof node.name === 'string') params.name = node.name;
  if (typeof node.width === 'number') params.width = node.width;
  if (typeof node.height === 'number') params.height = node.height;
  // 顶层保留 x/y；子节点位置由父级布局决定，不入模板。
  if (parentRef === -1) {
    if (typeof node.x === 'number') params.x = node.x;
    if (typeof node.y === 'number') params.y = node.y;
  }
  if (type === 'TEXT' && typeof node.characters === 'string') params.characters = node.characters;
  const index = out.push({ op, ref: parentRef, params }) - 1;
  if (typeof node.layoutMode === 'string') {
    out.push({ op: 'set-layout', ref: index, params: { layoutMode: node.layoutMode } });
  }
  if (typeof node.itemSpacing === 'number') {
    out.push({ op: 'set-item-spacing', ref: index, params: { itemSpacing: node.itemSpacing } });
  }
  const padding = {};
  for (const key of PADDING_KEYS) {
    if (typeof node[key] === 'number') padding[key] = node[key];
  }
  if (Object.keys(padding).length > 0) out.push({ op: 'set-padding', ref: index, params: padding });
  if (Array.isArray(node.fills) && node.fills[0] && typeof node.fills[0].hex === 'string') {
    out.push({ op: 'set-fill', ref: index, params: { hex: node.fills[0].hex } });
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) buildTemplate(child, index, out);
  }
  return out;
}

// 复放模板。write 为 async ({ op, parentId, nodeId, params }) => 回包；逐条执行并逐条断言。
// 返回值 steps 记录每条执行结果，供报告使用。
export async function replayTemplate(template, parentId, write) {
  if (typeof write !== 'function') throw new Error('write function required');
  const createdIds = [];
  const steps = [];
  for (let index = 0; index < template.length; index += 1) {
    const step = template[index];
    const isCreate = CREATE_SET.has(step.op);
    const ref = typeof step.ref === 'number' ? step.ref : -1;
    const targetId = isCreate ? (ref === -1 ? parentId : createdIds[ref]) : createdIds[ref];
    if (typeof targetId !== 'string' || targetId.length === 0) {
      throw new Error(`template step ${index} (${step.op}) ref ${ref} unresolved`);
    }
    const params = step.params ?? {};
    const result = await write({
      op: step.op,
      parentId: isCreate ? targetId : null,
      nodeId: isCreate ? null : targetId,
      params,
    });
    const target = result.deleted !== undefined ? result : result.node;
    if (isCreate) createdIds[index] = result.node.id;
    const assertions = expectedAssertions(step.op, params);
    const failures = [];
    for (const assertion of assertions) {
      const outcome = evaluateAssertion(target, assertion);
      if (!outcome.ok) failures.push({ assertion, reason: outcome.reason });
    }
    if (failures.length > 0) {
      throw new Error(`template step ${index} (${step.op}) assertion failed: ${failures[0].reason}`);
    }
    steps.push({ index, op: step.op, nodeId: isCreate ? result.node.id : targetId, assertions: assertions.length });
  }
  return steps;
}

export default buildTemplate;
