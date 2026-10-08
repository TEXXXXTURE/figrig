// 断言解析与求值模块。字段路径支持点号与下标写法；数值比较容差 1e-6。
// 导出 resolvePath、evaluateAssertion，供 CLI 断言核验使用。

const NUMBER_PATTERN = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const TOLERANCE = 1e-6;

// 将路径中的 [N] 展开为 .N，再按点号切分，空段丢弃。
// 返回 { found, value }；任一层级缺失返回 { found: false }。
export function resolvePath(root, path) {
  if (typeof path !== 'string') return { found: false };
  const trimmed = path.trim();
  if (trimmed.length === 0) return { found: false };
  const segments = trimmed
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment) => segment.length > 0);
  let current = root;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return { found: false };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
    current = current[segment];
  }
  return { found: true, value: current };
}

// 预期值类型推断：true/false 为布尔；数字字面量为数值；其余为字符串。
function parseExpected(raw) {
  if (raw === 'true') return { kind: 'boolean', value: true };
  if (raw === 'false') return { kind: 'boolean', value: false };
  if (NUMBER_PATTERN.test(raw)) return { kind: 'number', value: Number(raw) };
  return { kind: 'string', value: raw };
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function compare(actual, expected) {
  if (expected.kind === 'number') {
    if (typeof actual !== 'number' || !Number.isFinite(actual)) {
      return { ok: false, reason: `type mismatch: expected number, got ${describe(actual)}` };
    }
    if (Math.abs(actual - expected.value) > TOLERANCE) {
      return { ok: false, reason: `value mismatch: ${actual} != ${expected.value} (tolerance ${TOLERANCE})` };
    }
    return { ok: true };
  }
  if (expected.kind === 'boolean') {
    if (typeof actual !== 'boolean') {
      return { ok: false, reason: `type mismatch: expected boolean, got ${describe(actual)}` };
    }
    if (actual !== expected.value) {
      return { ok: false, reason: `value mismatch: ${actual} != ${expected.value}` };
    }
    return { ok: true };
  }
  if (typeof actual !== 'string') {
    return { ok: false, reason: `type mismatch: expected string, got ${describe(actual)}` };
  }
  if (actual !== expected.value) {
    return { ok: false, reason: `value mismatch: "${actual}" != "${expected.value}"` };
  }
  return { ok: true };
}

// 断言文本形式：exists 或 <路径>=<值>。
// 返回 { ok, assertion, path?, expected?, actual?, reason? }。
export function evaluateAssertion(target, assertion) {
  const text = typeof assertion === 'string' ? assertion.trim() : '';
  if (text.length === 0) {
    return { ok: false, assertion: String(assertion), reason: 'empty assertion' };
  }
  if (text === 'exists') {
    const ok = target !== null && target !== undefined;
    return { ok, assertion: text, reason: ok ? 'target exists' : 'target does not exist' };
  }
  const eq = text.indexOf('=');
  if (eq <= 0) {
    return { ok: false, assertion: text, reason: 'assertion must be "exists" or "<path>=<value>"' };
  }
  const path = text.slice(0, eq).trim();
  const expectedRaw = text.slice(eq + 1).trim();
  if (path.length === 0) {
    return { ok: false, assertion: text, reason: 'empty path' };
  }
  const resolved = resolvePath(target, path);
  if (!resolved.found) {
    return { ok: false, assertion: text, path, reason: `path not found: ${path}` };
  }
  const expected = parseExpected(expectedRaw);
  const outcome = compare(resolved.value, expected);
  const base = { assertion: text, path, expected: expectedRaw, actual: resolved.value };
  if (outcome.ok) return { ...base, ok: true };
  return { ...base, ok: false, reason: outcome.reason };
}

export default evaluateAssertion;
