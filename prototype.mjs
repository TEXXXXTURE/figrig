// prototype：交互原型链接解析与读回断言。schema 固定为 {"links":[...]}；
// 枚举非法报错不推断；同一 from 节点按本次输入整体替换 reactions。
// 供 CLI 的 prototype 命令与 test/verify.mjs 使用。

export const PROTOTYPE_TRIGGERS = Object.freeze(['click']);
export const PROTOTYPE_ACTIONS = Object.freeze(['navigate', 'overlay', 'scroll', 'back']);

const ACTION_TYPES = Object.freeze({ navigate: 'NODE', overlay: 'OVERLAY', scroll: 'SCROLL_TO', back: 'BACK' });

// 动作名 -> Figma action 类型名。未知返回 null。
export function actionTypeOf(action) {
  return Object.prototype.hasOwnProperty.call(ACTION_TYPES, action) ? ACTION_TYPES[action] : null;
}

// 动作对象构造：navigate -> NODE/NAVIGATE；overlay -> OVERLAY/overlayId；
// scroll -> SCROLL_TO/destinationId；back -> BACK。未知动作返回 null。
export function buildAction(link) {
  switch (link.action) {
    case 'navigate':
      return { type: 'NODE', destinationId: link.to, navigation: 'NAVIGATE' };
    case 'overlay':
      return { type: 'OVERLAY', overlayId: link.to };
    case 'scroll':
      return { type: 'SCROLL_TO', destinationId: link.to };
    case 'back':
      return { type: 'BACK' };
    default:
      return null;
  }
}

// 节点 id 归一：链接式（1-2）与内部式（1:2）统一为内部式。
function normalizeId(raw) {
  return String(raw).trim().replace(/-/g, ':');
}

// 解析并校验原型 JSON 文本。返回 payload links 数组：
// { from, trigger: 'ON_CLICK', action, to }；back 动作 to 为 null。
// 枚举、必填字段非法即抛错，不推断。
export function parseLinks(text) {
  let spec;
  try {
    spec = JSON.parse(text);
  } catch {
    throw new Error('invalid prototype json');
  }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec) || !Array.isArray(spec.links)) {
    throw new Error('prototype json must be {"links":[...]}');
  }
  const links = [];
  for (const item of spec.links) {
    if (item === null || typeof item !== 'object') throw new Error('each link must be an object');
    if (typeof item.from !== 'string' || item.from.trim().length === 0) throw new Error('link.from required');
    if (!PROTOTYPE_TRIGGERS.includes(String(item.trigger ?? ''))) {
      throw new Error(`invalid trigger: ${String(item.trigger)}; allowed: ${PROTOTYPE_TRIGGERS.join(', ')}`);
    }
    if (!PROTOTYPE_ACTIONS.includes(String(item.action ?? ''))) {
      throw new Error(`invalid action: ${String(item.action)}; allowed: ${PROTOTYPE_ACTIONS.join(', ')}`);
    }
    const from = normalizeId(item.from);
    if (!/^\d+:\d+$/.test(from)) throw new Error(`invalid from node id: ${item.from}`);
    if (item.action === 'back') {
      links.push({ from, trigger: 'ON_CLICK', action: 'back', to: null });
      continue;
    }
    if (typeof item.to !== 'string' || item.to.trim().length === 0) {
      throw new Error(`link.to required for action ${item.action}`);
    }
    const to = normalizeId(item.to);
    if (!/^\d+:\d+$/.test(to)) throw new Error(`invalid to node id: ${item.to}`);
    links.push({ from, trigger: 'ON_CLICK', action: item.action, to });
  }
  if (links.length === 0) throw new Error('links must not be empty');
  return links;
}

// 单条链接的读回匹配：trigger 类型、action 类型、destinationId/overlayId 逐项一致。
export function matchReaction(link, reaction) {
  if (reaction === null || typeof reaction !== 'object') return false;
  const trigger = reaction.trigger;
  if (!trigger || trigger.type !== link.trigger) return false;
  const action = reaction.action;
  const expectedType = actionTypeOf(link.action);
  if (!action || action.type !== expectedType) return false;
  if (link.action === 'navigate') return action.destinationId === link.to && action.navigation === 'NAVIGATE';
  if (link.action === 'overlay') return action.overlayId === link.to;
  if (link.action === 'scroll') return action.destinationId === link.to;
  return true;
}

// 读回核验：links 逐条在 readback 中命中，且同一 from 节点实际条数与本次输入一致（整体替换）。
// 返回失败项数组；空数组表示全部命中。
export function verifyReadback(links, readback) {
  const failures = [];
  const entries = Array.isArray(readback) ? readback : [];
  const bySource = new Map();
  for (const link of links) {
    const list = bySource.get(link.from) ?? [];
    list.push(link);
    bySource.set(link.from, list);
  }
  for (const link of links) {
    const entry = entries.find((item) => item && item.from === link.from);
    if (!entry) {
      failures.push({ from: link.from, action: link.action, reason: 'no readback for node' });
      continue;
    }
    const actual = Array.isArray(entry.actual) ? entry.actual : [];
    if (!actual.some((reaction) => matchReaction(link, reaction))) {
      failures.push({ from: link.from, action: link.action, to: link.to ?? null, reason: 'reaction not found in readback' });
    }
  }
  for (const [from, expectedLinks] of bySource) {
    const entry = entries.find((item) => item && item.from === from);
    const actual = entry && Array.isArray(entry.actual) ? entry.actual : [];
    if (actual.length !== expectedLinks.length) {
      failures.push({ from, reason: `reactions count mismatch: expected ${expectedLinks.length} got ${actual.length}` });
    }
  }
  return failures;
}

export default parseLinks;
