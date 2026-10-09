// task-store：任务记录模块。按 requestId 落盘任务记录，供幂等校验、状态流转与未完成任务查询。
// 记录字段：requestId、operation、nodeId、paramsHash、params、expect、status、reason、output、createdAt、updatedAt。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const TASK_DIR = resolve(process.cwd(), '.figrig-run', 'tasks');

export const STATES = Object.freeze(['queued', 'running', 'done', 'failed', 'unresolved', 'redoable']);

export function nowIso() {
  return new Date().toISOString();
}

// UUID v4。crypto.randomUUID 输出符合 RFC 4122 第 4 版格式。
export function uuidv4() {
  return randomUUID();
}

// 稳定序列化：对象键按字典序排列，递归处理数组与对象。undefined 记为 null。
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function hashParams(params) {
  return createHash('sha256').update(canonicalize(params)).digest('hex');
}

// 幂等判据哈希：覆盖操作参数与预期断言。
export function descriptorHash(descriptor) {
  return hashParams({ params: descriptor.params ?? {}, expect: descriptor.expect ?? [] });
}

function taskPath(requestId) {
  return join(TASK_DIR, `${requestId}.json`);
}

export function readTask(requestId) {
  if (typeof requestId !== 'string' || requestId.length === 0) return null;
  const path = taskPath(requestId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writeTask(task) {
  mkdirSync(TASK_DIR, { recursive: true });
  const record = { ...task, updatedAt: nowIso() };
  writeFileSync(taskPath(task.requestId), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

export function listTasks() {
  if (!existsSync(TASK_DIR)) return [];
  const result = [];
  for (const name of readdirSync(TASK_DIR)) {
    if (!name.endsWith('.json')) continue;
    const task = readTask(name.slice(0, -'.json'.length));
    if (task) result.push(task);
  }
  return result;
}

export function findTasks(predicate) {
  return listTasks().filter(predicate);
}

// 未完成任务：running 表示执行中，unresolved 表示结果不确定、待恢复。
export function incompleteTasks() {
  return listTasks().filter((task) => task.status === 'running' || task.status === 'unresolved');
}

export function hasIncompleteTask() {
  return incompleteTasks().length > 0;
}

export function createTask(descriptor) {
  return writeTask({
    requestId: descriptor.requestId,
    operation: descriptor.operation,
    nodeId: descriptor.nodeId ?? null,
    paramsHash: descriptorHash(descriptor),
    params: descriptor.params ?? {},
    expect: descriptor.expect ?? [],
    status: descriptor.status ?? 'queued',
    reason: descriptor.reason ?? null,
    output: null,
    createdAt: nowIso(),
  });
}

export function setTaskStatus(requestId, status, patch = {}) {
  const existing = readTask(requestId);
  if (!existing) throw new Error(`task not found: ${requestId}`);
  return writeTask({ ...existing, ...patch, status });
}

// 幂等判定：execute 执行、reused 返回上次结果、conflict 内容不一致、blocked 拒绝。
export function planOperation(descriptor, { mutation = false } = {}) {
  if (!descriptor || typeof descriptor.requestId !== 'string' || descriptor.requestId.length === 0) {
    throw new Error('descriptor.requestId required');
  }
  const paramsHash = descriptorHash(descriptor);
  const existing = readTask(descriptor.requestId);
  if (existing) {
    const reasons = [];
    if (existing.operation !== descriptor.operation) reasons.push(`operation ${existing.operation} != ${descriptor.operation}`);
    if ((existing.nodeId ?? null) !== (descriptor.nodeId ?? null)) reasons.push(`nodeId ${existing.nodeId} != ${descriptor.nodeId}`);
    if (existing.paramsHash !== paramsHash) reasons.push('params differ');
    if (reasons.length > 0) return { action: 'conflict', task: existing, reasons };
    if (existing.status === 'done') return { action: 'reused', task: existing };
    if (existing.status === 'redoable' || existing.status === 'queued') return { action: 'execute', task: existing };
    return { action: 'blocked', task: existing, reason: `task status ${existing.status}` };
  }
  if (mutation && hasIncompleteTask()) {
    return { action: 'blocked', task: null, reason: 'incomplete task present' };
  }
  return { action: 'execute', task: null };
}

export { TASK_DIR };
export default planOperation;
