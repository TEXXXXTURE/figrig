// recover：故障恢复模块。对处于 unresolved 的任务发起独立 inspect，按核验结果给出确定结论。
// 不重放原操作；结论限于 verified-present、verified-absent、unresolved 三种。

import { evaluateAssertion } from './assert.mjs';
import { CREATE_SET, expectedAssertions } from './ops.mjs';
import { listTasks, readTask, setTaskStatus } from './task-store.mjs';

function taskExpectations(task) {
  if (Array.isArray(task.expect) && task.expect.length > 0) return task.expect;
  return expectedAssertions(task.operation, task.params ?? {});
}

// 在父节点子树中查找满足全部预期断言的节点，先序返回首个。用于创建类操作的恢复核验。
function findMatch(node, expectations) {
  const queue = Array.isArray(node.children) ? [...node.children] : [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (expectations.every((assertion) => evaluateAssertion(current, assertion).ok)) return current;
    if (Array.isArray(current.children)) queue.push(...current.children);
  }
  return null;
}

// 按 requestId 或 nodeId 选取任务。requestId 优先。
export function selectTasks(selector) {
  if (selector && typeof selector.requestId === 'string' && selector.requestId.length > 0) {
    const task = readTask(selector.requestId);
    return task ? [task] : [];
  }
  if (selector && typeof selector.nodeId === 'string' && selector.nodeId.length > 0) {
    return listTasks().filter((task) => task.nodeId === selector.nodeId);
  }
  return [];
}

function mark(task, status, reason) {
  setTaskStatus(task.requestId, status, { reason });
  return status;
}

async function resolveTask(task, inspect) {
  const base = { requestId: task.requestId, operation: task.operation, nodeId: task.nodeId };
  if (task.status !== 'unresolved') {
    return { ...base, action: 'skipped', status: task.status, resolution: 'unresolved', reason: `task status ${task.status}` };
  }
  if (typeof task.nodeId !== 'string' || task.nodeId.length === 0) {
    const reason = 'no target nodeId for inspect';
    mark(task, 'unresolved', reason);
    return { ...base, action: 'unchanged', status: 'unresolved', resolution: 'unresolved', reason };
  }

  let probe;
  try {
    probe = await inspect(task.nodeId);
  } catch (error) {
    const reason = `inspect failed: ${error && error.message ? error.message : error}`;
    mark(task, 'unresolved', reason);
    return { ...base, action: 'unchanged', status: 'unresolved', resolution: 'unresolved', reason };
  }

  if (!probe || probe.found !== true) {
    // 目标缺失：删除类操作视为完成，其余视为未生效、可重做。
    if (task.operation === 'delete') {
      mark(task, 'done', 'verified-absent');
      return { ...base, action: 'resolved', status: 'done', resolution: 'verified-absent' };
    }
    mark(task, 'redoable', 'verified-absent');
    return { ...base, action: 'resolved', status: 'redoable', resolution: 'verified-absent' };
  }

  const expectations = taskExpectations(task);

  if (CREATE_SET.has(task.operation)) {
    // 创建类操作以父节点为查询目标，在子树中查找符合预期的结果节点。
    const match = findMatch(probe.node, expectations);
    if (match) {
      mark(task, 'done', 'verified-present');
      return { ...base, action: 'resolved', status: 'done', resolution: 'verified-present', assertions: expectations.length };
    }
    mark(task, 'redoable', 'verified-absent');
    return { ...base, action: 'resolved', status: 'redoable', resolution: 'verified-absent', assertions: expectations.length };
  }

  if (task.operation === 'delete') {
    const reason = 'target still present after delete';
    mark(task, 'unresolved', reason);
    return { ...base, action: 'unchanged', status: 'unresolved', resolution: 'unresolved', reason };
  }

  const mismatches = [];
  for (const assertion of expectations) {
    const outcome = evaluateAssertion(probe.node, assertion);
    if (!outcome.ok) mismatches.push({ assertion, reason: outcome.reason });
  }
  if (mismatches.length === 0) {
    mark(task, 'done', 'verified-present');
    return { ...base, action: 'resolved', status: 'done', resolution: 'verified-present', assertions: expectations.length };
  }
  const reason = `attribute mismatch: ${mismatches.map((item) => item.reason).join('; ')}`;
  mark(task, 'unresolved', reason);
  return { ...base, action: 'unchanged', status: 'unresolved', resolution: 'unresolved', reason, mismatches };
}

// id：requestId 字符串、{ requestId } 或 { nodeId }；inspect：async (nodeId) => { found, node }。
export async function resolveUnresolved(id, { inspect } = {}) {
  if (typeof inspect !== 'function') throw new Error('inspect function required');
  const selector = typeof id === 'string' ? { requestId: id } : (id ?? {});
  const tasks = selectTasks(selector);
  const outcomes = [];
  for (const task of tasks) {
    outcomes.push(await resolveTask(task, inspect));
  }
  const resolved = outcomes.filter((item) => item.action === 'resolved').length;
  const pending = outcomes.filter((item) => item.status === 'unresolved').length;
  return { total: outcomes.length, resolved, pending, outcomes };
}

export default resolveUnresolved;
